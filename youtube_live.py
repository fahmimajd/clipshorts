"""Bounded, anonymous reads of completed YouTube streams' storyboards and chat."""
from __future__ import annotations

from collections import Counter
import io
import json
import math
import os
import re
import threading
import time
from urllib.parse import urlsplit

import ssrf_guard
from yt_clients import HD_CLIENTS

_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_PREVIEW_SLOTS = threading.BoundedSemaphore(2)
_REPLAY = "youtube_live_chat_replay"
_MIB = 1024 * 1024
_PREVIEW_UNAVAILABLE = (
    "This stream has no landscape preview frame. If it just ended, try again after YouTube finishes processing it."
)
_PROCESSING = "YouTube is still processing this stream. Try again when its replay is ready."


class YouTubeLiveError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


class _QuietLogger:
    def debug(self, _msg): pass
    def info(self, _msg): pass
    def warning(self, _msg): pass
    def error(self, _msg): pass


def _watch_url(video_id):
    if not isinstance(video_id, str) or not _VIDEO_ID.fullmatch(video_id):
        raise YouTubeLiveError(400, "Choose a single YouTube livestream replay.")
    return f"https://www.youtube.com/watch?v={video_id}"


def _routes():
    yield ""  # An explicit empty proxy also ignores the environment's HTTP(S)_PROXY.
    paid = os.environ.get("PROXY_URL", "").strip()
    for proxy in os.environ.get("STATIC_PROXY_URLS", "").split(","):
        proxy = proxy.strip()
        if proxy and proxy != paid:
            yield proxy


def _on_routes(video_id, operation, *, timeout, max_bytes, max_requests):
    url = _watch_url(video_id)
    from yt_dlp import YoutubeDL
    from yt_dlp.networking import Request

    deadline = time.monotonic() + timeout
    requests = 0

    def budget_error():
        return YouTubeLiveError(503, "YouTube did not finish sending this replay in time. Try again or choose a shorter replay.")

    class BoundedYDL(YoutubeDL):
        def build_request_director(self, handlers, preferences=None):
            # Python socket resolution must stay under ssrf_guard, not libcurl.
            handlers = [h for h in handlers if h.RH_KEY.lower() in ("urllib", "requests")]
            return super().build_request_director(handlers, preferences)

        def urlopen(self, request):
            nonlocal requests, max_bytes
            remaining = deadline - time.monotonic()
            if remaining <= 0 or max_bytes <= 0 or requests >= max_requests:
                raise budget_error()
            requests += 1
            if isinstance(request, str):
                request = Request(request)
            request.extensions["timeout"] = min(4, remaining)
            # The urllib handler otherwise decompresses the whole response before read().
            request.headers["Accept-Encoding"] = "identity"
            response = super().urlopen(request)
            read = response.read
            received = 0

            def bounded_read(size=None):
                nonlocal received, max_bytes
                data = bytearray()
                while size is None or size < 0 or len(data) < size:
                    if time.monotonic() >= deadline:
                        response.close()
                        raise budget_error()
                    remaining = min(4 * _MIB - received, max_bytes)
                    amount = min(64 * 1024, remaining + 1)
                    if size is not None and size >= 0:
                        amount = min(amount, size - len(data))
                    chunk = read(amount)
                    if len(chunk) > remaining:
                        response.close()
                        raise budget_error()
                    if not chunk:
                        break
                    received += len(chunk)
                    max_bytes -= len(chunk)
                    data.extend(chunk)
                return bytes(data)

            response.read = bounded_read
            return response

    opts = {
        "skip_download": True, "quiet": True, "no_warnings": True, "noplaylist": True,
        "logger": _QuietLogger(), "ignore_no_formats_error": True, "cachedir": False,
        "extractor_retries": 0, "retries": 0, "fragment_retries": 0,
        "compat_opts": {"prefer-legacy-http-handler"},
        "extractor_args": {"youtube": {
            "player_client": list(HD_CLIENTS), "skip": ["hls", "dash"],
            "player_skip": ["js"], "fetch_pot": ["never"],
        }},
    }
    for proxy in _routes():
        try:
            with ssrf_guard.guarded(), BoundedYDL({**opts, "proxy": proxy}) as ydl:
                info = ydl.extract_info(url, download=False, process=False, ie_key="Youtube")
                duration, replay = _completed_replay(info, video_id)
                return operation(ydl, info, duration, replay)
        except YouTubeLiveError:
            raise
        except Exception:
            # Extractor exceptions may echo request bodies, response text or proxy credentials.
            if time.monotonic() >= deadline:
                break
    raise YouTubeLiveError(503, "Could not read this replay from YouTube. Try again shortly, or check that the replay is public.")


def _completed_replay(info, video_id):
    if not info or info.get("id") != video_id:
        raise ValueError("missing video metadata")
    status = info.get("live_status")
    if status in ("is_live", "is_upcoming"):
        raise YouTubeLiveError(422, "Gaming Stream mode needs an ended YouTube livestream. Try again after it ends.")
    duration = info.get("duration")
    valid_duration = isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0
    if status == "post_live" or (status == "was_live" and not valid_duration):
        raise YouTubeLiveError(409, _PROCESSING)
    if info.get("availability") in ("private", "premium_only", "subscriber_only", "needs_auth"):
        raise YouTubeLiveError(422, "Choose a YouTube livestream replay that anyone can open without signing in.")
    if not valid_duration:
        raise ValueError("incomplete video metadata")
    if status != "was_live":
        raise YouTubeLiveError(422, "Choose a completed YouTube livestream, not a regular upload.")
    tracks = (info.get("subtitles") or {}).get("live_chat") or ()
    for track in tracks:
        if track.get("protocol") == _REPLAY and track.get("video_id") == video_id and track.get("url"):
            return float(duration), track
    raise YouTubeLiveError(
        422, "This stream has no public live chat replay. Wait if it just ended, or choose one with chat replay enabled.")


def _storyboard_tile(formats, video_id, duration, seconds):
    selected = None
    area = 0
    for fmt in formats:
        if fmt.get("protocol") != "mhtml":
            continue
        w, h, cols, rows = (fmt.get(k) for k in ("width", "height", "columns", "rows"))
        fps = fmt.get("fps")
        if (not all(isinstance(v, int) and v > 0 for v in (w, h, cols, rows))
                or w <= h or w * h <= area or w * h * cols * rows > 4 * _MIB
                or not isinstance(fps, (int, float)) or not (0 < fps <= 60)):
            continue
        frame_count = round(fps * duration)
        if not frame_count:
            continue
        frame = min(frame_count - 1, int(seconds * fps))
        page, tile = divmod(frame, cols * rows)
        fragments = fmt.get("fragments") or ()
        if page >= len(fragments):
            continue
        url = fragments[page].get("url") or ""
        parts = urlsplit(url)
        if not (parts.scheme == "https" and parts.netloc == "i.ytimg.com"
                and parts.path.startswith(f"/sb/{video_id}/")):
            continue
        row, col = divmod(tile, cols)
        selected = url, (col * w, row * h, (col + 1) * w, (row + 1) * h), frame / fps
        area = w * h
    if selected is None:
        raise YouTubeLiveError(422, _PREVIEW_UNAVAILABLE)
    return selected


def preview(video_id: str, seconds: float | None = None) -> tuple[bytes, float, float]:
    """Return the storyboard JPEG, VOD duration and actual sample time."""
    if seconds is not None and (not math.isfinite(seconds) or seconds < 0):
        raise YouTubeLiveError(400, "Preview time must be a nonnegative number.")
    if not _PREVIEW_SLOTS.acquire(blocking=False):
        raise YouTubeLiveError(429, "Too many replay previews are loading. Try again in a moment.")

    def read_frame(ydl, info, duration, _replay):
        from PIL import Image, UnidentifiedImageError
        from yt_dlp.networking.exceptions import HTTPError

        at = duration / 2 if seconds is None else min(seconds, duration)
        url, box, actual = _storyboard_tile(info.get("formats") or (), video_id, duration, at)
        try:
            with ydl.urlopen(url) as response:
                raw = response.read(2 * _MIB + 1)
        except HTTPError as exc:
            if exc.status not in (404, 410):
                raise
            raise YouTubeLiveError(422, _PREVIEW_UNAVAILABLE) from None
        if len(raw) > 2 * _MIB:
            raise YouTubeLiveError(422, _PREVIEW_UNAVAILABLE)
        try:
            with Image.open(io.BytesIO(raw), formats=("JPEG", "WEBP", "PNG")) as sheet:
                if sheet.width * sheet.height > 4 * _MIB or box[2] > sheet.width or box[3] > sheet.height:
                    raise YouTubeLiveError(422, _PREVIEW_UNAVAILABLE)
                out = io.BytesIO()
                sheet.crop(box).convert("RGB").save(out, format="JPEG", quality=90)
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
            raise YouTubeLiveError(422, _PREVIEW_UNAVAILABLE) from None
        return out.getvalue(), duration, actual

    try:
        return _on_routes(video_id, read_frame, timeout=18, max_bytes=12 * _MIB, max_requests=36)
    finally:
        _PREVIEW_SLOTS.release()


def _message_events(line):
    try:
        replay = json.loads(line)["replayChatItemAction"]
        offset = replay["videoOffsetTimeMsec"]
        if not isinstance(offset, (str, int)) or isinstance(offset, bool):
            return
        seconds = int(offset) / 1000
        actions = replay["actions"]
    except (ValueError, TypeError, KeyError, OverflowError):
        return
    if seconds < 0 or not isinstance(actions, list):
        return
    for action in actions:
        for renderer in ("liveChatTextMessageRenderer", "liveChatPaidMessageRenderer", "liveChatPaidStickerRenderer"):
            try:
                author = action["addChatItemAction"]["item"][renderer]["authorExternalChannelId"]
            except (KeyError, TypeError):
                continue
            if isinstance(author, str) and 0 < len(author) <= 64:
                yield seconds, author
                break


def fetch_chat(video_id: str) -> list[tuple[float, str]]:
    """Read only replay chat, retaining timestamps and author IDs in memory."""
    def read_chat(ydl, _info, _duration, replay):
        from yt_dlp.downloader.youtube_live_chat import YoutubeLiveChatFD
        from yt_dlp.networking import Request

        # Use the upstream continuation parser but keep raw watch pages and chat
        # out of FragmentFD's scratch files and never write the raw JSONL stream.
        events = []

        class ReplayFD(YoutubeLiveChatFD):
            def _prepare_and_start_frag_download(self, ctx, info_dict):
                ctx["body"] = b""

            def _download_fragment(self, ctx, frag_url, info_dict, headers=None, request_data=None):
                with ydl.urlopen(Request(frag_url, data=request_data, headers=headers)) as response:
                    ctx["body"] = response.read()
                return True

            def _read_fragment(self, ctx):
                return ctx.pop("body")

            def _append_fragment(self, ctx, data):
                for line in io.BytesIO(data):
                    for event in _message_events(line):
                        if len(events) >= 250_000:
                            raise YouTubeLiveError(422, "This replay has too much live chat to analyze. Choose a shorter replay.")
                        events.append(event)

            def _finish_frag_download(self, ctx, info_dict):
                if not events:
                    raise YouTubeLiveError(422, "The live chat replay contains no viewer messages. Choose a stream with active chat.")
                return True

        if not ReplayFD(ydl, ydl.params).real_download("-", replay):
            raise ValueError("incomplete chat replay")
        return events

    return _on_routes(video_id, read_chat, timeout=120, max_bytes=128 * _MIB, max_requests=4000)


def clip_candidates(events, *, source_start, duration, clip_seconds, limit):
    """Rank distinct chatter counts and rebase non-overlapping cuts to the rendered source."""
    if duration <= 0 or clip_seconds <= 0 or limit <= 0:
        return []
    source_end = source_start + duration
    ordered = sorted((t, author) for t, author in events if source_start <= t < source_end)
    length = min(float(clip_seconds), float(duration))
    lead = min(5.0, length / 2)
    window = min(15.0, length - lead)
    active = Counter()
    peaks = []
    right = 0
    for left, (onset, author) in enumerate(ordered):
        while right < len(ordered) and ordered[right][0] - onset < window:
            active[ordered[right][1]] += 1
            right += 1
        if left == 0 or onset != ordered[left - 1][0]:
            start = max(0.0, min(onset - source_start - lead, duration - length))
            peaks.append((-len(active), start))
        active[author] -= 1
        if not active[author]:
            del active[author]

    clips = []
    for score, start in sorted(peaks):
        end = min(float(duration), start + length)
        if any(start < clip["end"] and clip["start"] < end for clip in clips):
            continue
        clips.append({"start": start, "end": end, "viewers": -score})
        if len(clips) == limit:
            break
    return clips
