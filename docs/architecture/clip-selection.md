# Clip selection

## How many clips a job returns (`clip_selection.py`, `main.get_viral_clips`)

The count is not a setting, it is derived. `get_viral_clips` builds ~90 s scoring
windows over the transcript, scores them in batches, shortlists the best
`shortlist_target` (`min(10, duration//90 + 2)`, floor 3) and asks the detail pass
for `clip_count_targets(len(shortlist))` clips. The floor matters: jobs that
return only 1-3 clips retain far worse than jobs that return 4-9.

Two invariants keep that chain from leaking:

- **The scoring pass ranks, it does not select.** The prompt scores **every**
  window and the shortlist is the global top N. A prompt that says "choose up to
  3 windows from this batch" caps the shortlist at `3 * n_batches` instead of the
  target and starves every source under ~30 min. Batches are near-equal
  (`score_batches`): a trailing batch of one window would return that window
  whatever its score.
  At most two scoring batches run concurrently per job. Results are merged in
  transcript order before ranking, so a tied score does not depend on which
  provider request finished first.
- **The clip floor is enforced in code, not just in the prompt.** When the detail
  pass comes back under `min_clips`, the shortlist windows that produced nothing
  get one more call for the difference. An empty answer is accepted: padding is
  worse than a short list.

`target_clips` on `/api/process` (dashboard: advanced options) pins both ends via
`CLIP_TARGET_MIN` / `CLIP_TARGET_MAX` when the user wants an exact number.

## YouTube captions for selection, Whisper for subtitles

For a whole YouTube source without a cached or supplied full transcript, the
job fetches original-language captions alongside the video download. The
existing two-pass picker scores the caption text and gets cue timestamps in its
detail pass. Whisper transcribes only the winning ranges, with three seconds of
audio on each side and overlapping ranges merged. The picker refines the cuts
against those words before rendering. Only Whisper words feed subtitles.

Missing, sparse, or poorly aligned captions fall back to full-source ASR, as do
caption-driven picks that cannot be confirmed against the audio. Uploads and
jobs capped to part of the source still use the existing ASR path. Compatible
remote workers get caption-only checkpoints; those aren't full ASR cache entries.

The clip editor stores which source intervals Whisper covered, including silence.
On save, it transcribes any newly selected intervals from the retained source
and keeps their words for subsequent edits. The initial video download and render
still run; the optimization reduces the audio Whisper has to process.

## Silent footage: the vision fallback (`main.get_visual_clips`)

`transcribe_video` raising `NoAudioError`, **or** `speech_is_sparse()` returning
true, both set `transcript = None` and route to `get_visual_clips`. Sparse means
under `MIN_SPEECH_WORDS` (8) in total or under `MIN_SPEECH_WORDS_PER_MIN` (5).
Music-only footage and mic-muted recordings transcribe to a handful of stray
words; without the second test the picker scores those words and cuts around
them.

The vision pass uploads the video, Gemini returns the same `{"shorts"}` shape
(`gemini_worker.VisualResponse`) in the same 15-60 s band, so every later stage
is identical. `CLIP_TARGET_MIN`/`MAX` apply directly (there are no scoring
windows). The transcript is stored as `{"language": "none", "segments": []}`, so
the clips have no subtitles, which is correct.

**This is the one stage that sends Gemini the video instead of frames, on
purpose**: frames can say what kind of video it is, not which 40 seconds to cut.
Gemini counts video at ~300 tokens/second, so an hour is ~1.08M tokens, past a 1M
window. A source longer than `VISION_SEGMENT_SECONDS` (2400) is therefore split by
`clip_selection.vision_segments` into near-equal stretches (no one-minute tail),
each re-encoded to a 360p / 1 fps proxy (`_vision_proxy`: re-encoded, not
stream-copied, or every timestamp would be off by up to a GOP), watched on its
own, offset back to source time, then merged with `dedupe_overlapping` +
`trim_to_best` to `CLIP_TARGET_MAX`. One failed stretch is logged and skipped.
`VISION_MAX_SEGMENTS` (8, ~5 h 20) bounds the spend of one job; past it only the
first stretches are watched. A source that fits one stretch is one stretch: it
goes through the same proxy, never as the raw file (a broken capture, such as an
HLS VOD whose audio will not decode, made Gemini answer 400 INVALID_ARGUMENT).
When the proxy's audio cannot be encoded it is retried without audio. Do not
port the frame trick here. Gemini-only: a
text-only `LLM_BASE_URL` server cannot see footage, and without `GEMINI_API_KEY`
the function logs one line and returns None, which fails the job.

The public `/gta-5-clips`, `/gta-6-clips`, `/wow-forever-clips` and `/platforms/twitch` pages state
these thresholds and the stretch sizes; if the behaviour changes, change
`dashboard/seo/pages.js` and `dashboard/seo/clip-tools.js` too.

## Local LLM for the moment picker (`llm_backend.py`)

`LLM_BASE_URL` (+ `LLM_MODEL`, `LLM_API_KEY`) routes the two transcript passes of
`get_viral_clips` to any OpenAI-compatible `/chat/completions` instead of Gemini;
the response is validated with the same pydantic schemas Gemini enforces
server-side, so `main.py` sees one shape. `main.score_batch_size` drops to 3
windows per call there (local contexts are 4-8k; a truncated prompt scores garbage
silently). Self-host `/api/process` then accepts a request without
`X-Gemini-Key` and `/api/config.localLlm` tells the dashboard not to demand one.
Frame-based stages (`layout_picker`, `screencast_layout`, `get_visual_clips`)
stay on Gemini. Never wired in cloud mode: `BILLING_ENABLED` ignores it.

## YouTube Live replay highlights (`youtube_live.py`)

The YouTube Live input only accepts completed landscape replays with public
live chat. Preview reads one YouTube storyboard tile. The job fetches the chat
replay via yt-dlp, anonymous direct then static, never over the paid proxy.
All requests and bytes are bounded. Chat text and author IDs are not stored.
A selected source range stops the sequential chat download at its end. The
budget scales by each started hour from the beginning of the replay to that
end (or to the end of the stream for a full replay): 30 minutes, 4,000
requests, and 512 MiB per hour of replay, up to 2 hours of download time,
16,000 requests, and 2 GiB total. The 4 MiB per-response and 250,000-event
limits do not scale. If a limit is hit, the job reports which one and fails
rather than ranking a partial replay.

Once chat is downloaded, rank 10-second windows spaced 5 seconds apart by
distinct chatters. Short clips use a shorter scoring window so the counted
reactions fit. Take the highest-ranked non-overlapping clips, starting up to
10 seconds before the first chat message in the window to account for
reaction delay. The lead-in is capped at half the clip length. Chat times are
absolute in the VOD; clip times are rebased to any source cut. Without usable
chat, the job fails rather than switching to transcript selection.
Whisper transcribes only the selected ranges for captions or hook grounding.
Chat chooses the moment; it does not write the title or hook. For those,
Gemini uses the rendered frames and speech when configured, or the server's
OpenAI-compatible provider uses the clip's speech alone. Without usable
context or a provider, the clip keeps its numbered title and no automatic hook.
