import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { loginUrl, prepareReplizForm, ReplizLoginRequired, scheduleUrl } from './form.mjs';

const fixture = `
<button onclick="document.querySelector('#choices').show()">Jadwal baru</button>
<dialog id="choices"><button onclick="this.closest('dialog').close(); document.querySelector('#composer').show()"><span>Buat Konten</span></button></dialog>
<dialog id="composer">
  <button role="radio" onclick="document.querySelector('#media').hidden = false">Video</button>
  <section id="media" hidden>
    <textarea placeholder="Masukan deskripsi" maxlength="80"></textarea>
    <button onclick="document.querySelector('input[type=file]').click()"><span>Unggah</span><span>0/1</span></button>
    <input type="file" hidden onchange="document.querySelector('[aria-label=Hapus]').hidden = false">
    <button aria-label="Hapus" hidden>x</button>
  </section>
  <button onclick="document.querySelector('#accounts').showModal()">Akun</button>
  <input id="post-title" placeholder="Masukan judul" hidden>
  <button onclick="this.dataset.clicked = 'true'" hidden>Sekarang</button>
  <button onclick="this.dataset.clicked = 'true'">Simpan</button>
</dialog>
<dialog id="accounts"><button onclick="document.querySelector('#post-title').hidden = false; [...document.querySelectorAll('button')].find(b => b.textContent === 'Sekarang').hidden = false; this.closest('dialog').close()">YouTube Test</button></dialog>`;

test('attaches the requested clip, waits for destination, fills Now, never saves', { timeout: 30_000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'openshorts-repliz-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'test.mp4');
  await writeFile(file, 'test-video-bytes');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(6_000);
  await page.route(scheduleUrl, (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
  const title = 'Judul klip: café!';
  await Promise.all([
    prepareReplizForm(page, file, title),
    page.getByRole('button', { name: 'YouTube Test' }).click(),
  ]);
  const attached = await page.locator('input[type=file]').evaluate(async (el) => [el.files[0].name, await el.files[0].text()]);
  assert.deepEqual(attached, ['test.mp4', 'test-video-bytes']);
  assert.equal(await page.getByPlaceholder('Masukan judul').inputValue(), title);
  assert.equal(await page.getByPlaceholder('Masukan deskripsi').inputValue(), title);
  assert.equal(await page.getByRole('button', { name: 'Sekarang' }).getAttribute('data-clicked'), 'true');
  assert.equal(await page.getByRole('button', { name: 'Simpan' }).getAttribute('data-clicked'), null);
});

test('hands an expired session off before opening the composer or touching a file', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(6_000);
  await page.route(scheduleUrl, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<button onclick="this.dataset.clicked = 'true'">Sign in with Google</button>
      <script>history.replaceState(null, '', '/login');</script>`,
  }));
  await assert.rejects(prepareReplizForm(page, 'not-a-file.mp4', 'Never prepared'), ReplizLoginRequired);
  assert.equal(await page.getByRole('button', { name: 'Sign in with Google' }).getAttribute('data-clicked'), null);
});
