const FOUND = /^(?:🔥\s*)?Found (\d+) (?:viral )?clips\b/;
const READY = /^(?:✅\s*)?Clip (\d+) ready\b/;
const RENDER = /^(?:🎬\s*)?(?:Processing|Creating) clip (\d+)\b/i;
const OVERLAY = /^(Adding (?:subtitles and hook|subtitles|hook)) to clip (\d+)$/;
const FAILED = /^(?:❌\s*)?Clip (\d+) failed\b/;
const RETRY = /^(?:🔁\s*)?Retrying clip (\d+)\b/;
const DOWNLOAD = /Downloading video|Download attempt:|\[download\]/;
const TRANSCRIBE = /Transcribing (?:audio|video)|Transcribing…/;
const SELECT = /Analyzing with (?:Gemini|local LLM|OpenAI-compatible provider)|Finding the best moments|finding moments in the picture/;

// What each plan gets out of one video (the server enforces it; this is copy).
// The free plan: its best clips, fewer while the free queue is busy.
export const FREE_CLIPS_PER_VIDEO = 2;
export const FREE_CLIPS_QUIET = 4;
export const MAX_CLIPS_PER_VIDEO = 15;

export function clipProgress(logs) {
  let total = 0;
  let phase = 'Preparing source';
  const ready = new Set();
  const active = new Map();
  for (const line of logs || []) {
    const text = String(line).trimStart();
    const found = FOUND.exec(text);
    if (found) {
      total = Number(found[1]);
      phase = 'Rendering clips';
      continue;
    }
    if (!total) {
      // Download progress can interleave with early transcription and selection.
      if (SELECT.test(text)) phase = 'Selecting moments';
      else if (phase !== 'Selecting moments' && TRANSCRIBE.test(text)) phase = 'Transcribing audio';
      else if (phase === 'Preparing source' && DOWNLOAD.test(text)) phase = 'Downloading video';
      continue;
    }
    const done = READY.exec(text);
    if (done) {
      ready.add(done[1]);
      active.delete(done[1]);
      continue;
    }
    const overlay = OVERLAY.exec(text);
    if (overlay) { active.set(overlay[2], overlay[1]); continue; }
    const rendering = RENDER.exec(text);
    if (rendering) { active.set(rendering[1], 'Cutting and reframing'); continue; }
    const failed = FAILED.exec(text);
    if (failed) { active.delete(failed[1]); continue; }
    const retry = RETRY.exec(text);
    if (retry) active.set(retry[1], 'Retrying render');
  }
  const activities = {};
  for (const stage of active.values()) activities[stage] = (activities[stage] || 0) + 1;
  if (total > 0 && ready.size >= total) phase = 'Finalizing results';
  return { total, ready: Math.min(ready.size, total), phase, activities };
}
