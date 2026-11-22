import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { chromium } from 'playwright';
import { loginUrl, prepareReplizForm, ReplizLoginRequired } from './form.mjs';

const port = 8766;
const origins = new Set(['http://localhost:5175', 'http://127.0.0.1:5175', 'http://localhost:5173', 'http://127.0.0.1:5173']);
const galleryOrigin = 'http://127.0.0.1:8000';
const maxBytes = 150_000_000;
let context, draftPage, preparing, loginBrowser;

function installedBrowser() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const [name, path] of [
    ['brave', 'BraveSoftware/Brave-Browser/Application/brave.exe'],
    ['chrome', 'Google/Chrome/Application/chrome.exe'],
    ['edge', 'Microsoft/Edge/Application/msedge.exe'],
  ]) {
    const executablePath = roots.map((root) => join(root, path)).find(existsSync);
    if (executablePath) {
      return { executablePath, profile: join(process.env.LOCALAPPDATA || homedir(), 'OpenShorts', `repliz-${name}`) };
    }
  }
  throw new RequestError(503, 'Install Brave, Chrome, or Edge on this Windows computer before using Repliz.');
}

async function openManualLogin({ executablePath, profile }) {
  const child = spawn(executablePath, [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', loginUrl,
  ], { detached: true, stdio: 'ignore' });
  loginBrowser = child;
  const done = () => { if (loginBrowser === child) loginBrowser = undefined; };
  child.once('exit', done);
  child.once('error', done);
  await once(child, 'spawn');
  child.unref();
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readClipId(req) {
  let body = '';
  for await (const part of req.setEncoding('utf8')) {
    body += part;
    if (body.length > 4096) throw new RequestError(413, 'Clip request is too large.');
  }
  let clipId;
  try {
    clipId = JSON.parse(body)?.clip_id;
  } catch {
    throw new RequestError(400, 'Invalid clip request.');
  }
  if (typeof clipId !== 'string' || !/^[0-9a-f-]{36}\/[^/\\\u0000-\u001f]+\.mp4$/i.test(clipId)) {
    throw new RequestError(400, 'Choose a saved MP4 from Gallery.');
  }
  return clipId;
}

async function getClip(id) {
  const gallery = await fetch(`${galleryOrigin}/api/local-gallery`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!gallery.ok) throw new RequestError(503, 'Could not open the local Gallery. Check that OpenShorts is running.');
  const { videos } = await gallery.json();
  const clip = videos.find((video) => video.id === id);
  if (!clip) throw new RequestError(404, 'That saved clip is no longer in Gallery. Refresh and choose its current render.');
  return clip;
}

async function downloadClip(clipId, output) {
  const [job, filename] = clipId.split('/');
  const video = await fetch(`${galleryOrigin}/videos/${job}/${encodeURIComponent(filename)}`, {
    redirect: 'error', signal: AbortSignal.timeout(90_000),
  });
  if (!video.ok || !video.body || !video.headers.get('content-type')?.startsWith('video/mp4')) {
    await video.body?.cancel();
    throw new RequestError(404, 'Could not read the saved MP4.');
  }
  const tooLarge = () => new RequestError(413, 'This clip exceeds the 150 MB Repliz browser upload limit.');
  if (Number(video.headers.get('content-length')) > maxBytes) {
    await video.body.cancel();
    throw tooLarge();
  }
  let size = 0;
  await pipeline(video.body, new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) done(tooLarge());
      else done(null, chunk);
    },
  }), createWriteStream(output, { flags: 'wx', mode: 0o600 }));
  if (size === 0) throw new RequestError(404, 'The saved MP4 is empty.');
}

async function prepare(clip) {
  const browser = installedBrowser();
  const folder = await mkdtemp(join(tmpdir(), 'openshorts-repliz-'));
  const cleanup = () => rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
    console.error('Could not clean up a temporary Repliz clip.');
  });
  const path = join(folder, 'clip.mp4');
  let pageOwnsFile = false;
  try {
    await downloadClip(clip.id, path);
    if (!context) {
      context = await chromium.launchPersistentContext(browser.profile, {
        executablePath: browser.executablePath, headless: false, viewport: null, chromiumSandbox: true,
      }).catch(() => {
        throw new RequestError(503, 'Could not open the Repliz browser profile. Close its browser windows and try again.');
      });
      context.once('close', () => { context = undefined; });
    }
    draftPage = context.pages().find((page) => page.url() === 'about:blank') || await context.newPage();
    draftPage.setDefaultTimeout(15_000);
    draftPage.once('close', cleanup);
    pageOwnsFile = true;
    await draftPage.bringToFront();
    await prepareReplizForm(draftPage, path, clip.title);
  } catch (error) {
    if (!(error instanceof ReplizLoginRequired)) throw error;
    await context.close();
    await openManualLogin(browser);
    throw new RequestError(401, 'Sign in to Repliz in the browser that just opened. After sign-in, close that window and click Prepare in Repliz again.');
  } finally {
    if (!pageOwnsFile) await cleanup();
  }
}

const server = createServer(async (req, res) => {
  const reply = (status, body) => res.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  }).end(JSON.stringify(body));
  if (!origins.has(req.headers.origin) || req.headers.host !== `127.0.0.1:${port}`) {
    return reply(403, { detail: 'Use the OpenShorts dashboard on localhost.' });
  }
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Vary', 'Origin');
  if (req.url !== '/prepare') return reply(404, { detail: 'Not found.' });
  if (req.method === 'OPTIONS') {
    if (req.headers['access-control-request-method'] !== 'POST') return reply(405, { detail: 'Use POST.' });
    return res.writeHead(204, {
      'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
    }).end();
  }
  if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
    return reply(400, { detail: 'Expected a JSON clip request.' });
  }
  if (loginBrowser) {
    return reply(409, { detail: 'Finish signing in, then close the separate Repliz browser window and try again.' });
  }
  if (preparing || (draftPage && !draftPage.isClosed())) {
    return reply(409, { detail: 'Finish or close the earlier Repliz tab before opening another clip.' });
  }
  preparing = true;
  try {
    const id = await readClipId(req);
    await prepare(await getClip(id));
    reply(200, { ready: true });
  } catch (error) {
    if (error instanceof RequestError) {
      reply(error.status, { detail: error.message });
    } else {
      console.error(`Repliz preparation stopped (${error.name}).`);
      reply(502, { detail: 'Could not finish preparing Repliz. Check the browser tab and do not assume the clip or Now was set. Close the tab to retry.' });
    }
  } finally {
    preparing = false;
  }
});
server.listen(port, '127.0.0.1', () => console.log(`OpenShorts Repliz helper listening on 127.0.0.1:${port}.`));
