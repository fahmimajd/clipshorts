import asyncio
import json
from pathlib import Path
import shutil
import struct
import subprocess
from unittest.mock import AsyncMock

import httpx
from PIL import Image
import pytest

import campaign


pytestmark = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="FFmpeg required")


def _video(path, pattern, seconds, audio=False):
    args = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", pattern]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440"]
    subprocess.run([*args, "-t", str(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", str(path)], check=True, timeout=20)


@pytest.mark.parametrize("body_audio", [True, False])
def test_ending_follows_the_clip_and_keeps_audio(tmp_path, monkeypatch, body_audio):
    monkeypatch.setenv("GPU_DECODE", "0")
    monkeypatch.setenv("FFMPEG_ENCODER", "x264")
    clip = tmp_path / "demo_clip_1.mp4"
    _video(clip, "color=red:s=96x160:r=12", 1, audio=body_audio)
    original = clip.read_bytes()
    upload = tmp_path / "ending.mp4"
    _video(upload, "color=blue:s=160x96:r=25", 0.8, audio=not body_audio)
    with upload.open("rb") as file:
        campaign.save_video_asset(file, tmp_path / campaign.OUTRO_ASSET)
    if body_audio:
        Image.new("RGBA", (16, 16), "lime").save(tmp_path / campaign.LOGO_ASSET)

    delivered = campaign.render(str(clip))
    assert clip.read_bytes() == original
    assert campaign.render(delivered) == delivered

    def frame_at(t):
        data = subprocess.check_output([
            "ffmpeg", "-v", "error", "-ss", str(t), "-i", delivered, "-frames:v", "1",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], timeout=20)
        return Image.frombytes("RGB", (96, 160), data)

    before, after = frame_at(0.25), frame_at(1.65)
    assert before.getpixel((48, 80))[0] > 200
    assert after.getpixel((48, 80))[2] > 200
    assert max(after.getpixel((48, 14))) < 20  # Wide template fits with padding, not stretching.
    if body_audio:
        assert before.getpixel((48, 14))[1] > 200
    duration = float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", delivered], text=True, timeout=15))
    assert duration == pytest.approx(1.8, abs=0.05)
    pcm = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", delivered, "-map", "0:a:0",
        "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], timeout=20)
    peaks = [max(abs(x) for (x,) in struct.iter_unpack("<h", pcm[i:i + 1600]))
             for i in (3200, 19200)]
    sound, silence = peaks if body_audio else peaks[::-1]
    assert sound > 500 and silence < 20


def _motion_logo(path):
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "nullsrc=s=32x16:r=8:d=0.5,format=gbrap,"
        "geq=r=0:g='if(lt(T,0.25),255,0)':b='if(lt(T,0.25),0,255)':a='if(lt(X,16),255,0)'",
        "-f", "lavfi", "-i", "sine=frequency=880:duration=0.5",
        "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-c:a", "pcm_s16le",
        str(path),
    ], check=True, timeout=20)


@pytest.mark.parametrize("live_banner", [False, True])
def test_mov_watermark_loops_transparently_without_audio(tmp_path, monkeypatch, live_banner):
    monkeypatch.setenv("GPU_DECODE", "0")
    monkeypatch.setenv("FFMPEG_ENCODER", "x264")
    clip = tmp_path / "clip.mp4"
    _video(clip, "color=red:s=96x160:r=8", 1.5)
    if live_banner:
        _video(tmp_path / campaign.OUTRO_ASSET, "color=yellow:s=96x160:r=8", 0.5)
    unmarked = campaign.render(str(clip), live_banner=live_banner)
    if not live_banner:
        assert unmarked == str(clip)
    _, _, unmarked_duration = campaign._video_info(unmarked)

    logo = tmp_path / "logo.mov"
    _motion_logo(logo)
    with logo.open("rb") as file:
        campaign.save_video_asset(file, tmp_path / campaign.MOTION_LOGO_ASSET)
    assert campaign.has_assets(tmp_path)

    delivered = campaign.render(str(clip), live_banner=live_banner)
    _, audio, duration = campaign._video_info(delivered)
    assert audio is None  # The MOV's audio must not leak into a silent clip.
    assert duration == pytest.approx(unmarked_duration, abs=0.02)
    y = 90 if live_banner else 14

    def frame_at(path, seconds):
        data = subprocess.check_output([
            "ffmpeg", "-v", "error", "-ss", str(seconds), "-i", path,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ], timeout=20)
        return Image.frombytes("RGB", (96, 160), data)

    first_frame = frame_at(delivered, 0.125)
    for seconds, channel in ((0.125, 1), (0.375, 2), (0.625, 1), (1.25, 2)):
        frame = first_frame if seconds == 0.125 else frame_at(delivered, seconds)
        assert frame.getpixel((42, y))[channel] > 200
        assert frame.getpixel((54, y))[0] > 200
        assert frame.getpixel((42, 14 if live_banner else 90))[0] > 200

    (tmp_path / campaign.MOTION_LOGO_ASSET).unlink()
    still = Image.new("RGBA", (32, 16))
    still.paste("lime", (0, 0, 16, 16))
    still.save(tmp_path / campaign.LOGO_ASSET)
    still_frame = frame_at(campaign.render(str(clip), live_banner=live_banner), 0.125)

    def green_bounds(frame):
        return frame.getchannel("G").point(lambda value: 255 if value > 160 else 0).getbbox()

    assert green_bounds(first_frame) == pytest.approx(green_bounds(still_frame), abs=2)


@pytest.mark.parametrize("watermark", [False, True])
def test_process_accepts_campaign_video_for_live_url(tmp_path, monkeypatch, watermark):
    api = pytest.importorskip("app")
    monkeypatch.setattr(api, "OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setattr(api, "jobs", {})
    monkeypatch.setattr(api, "_enqueue_job", lambda *_: None)
    monkeypatch.setattr(api, "resolve_gemini", AsyncMock(return_value="test-key"))
    monkeypatch.setattr(api, "_validate_source_url", AsyncMock())
    monkeypatch.setattr(api, "QUALITY_GATE_MIN_HEIGHT", 0)
    monkeypatch.setattr(api, "MIN_SOURCE_SECONDS", 0)
    if watermark:
        field, name, content_type = "campaign_watermark_video", campaign.MOTION_LOGO_ASSET, "video/quicktime"
        asset = tmp_path / "upload.mov"
        _motion_logo(asset)
    else:
        field, name, content_type = "campaign_outro", campaign.OUTRO_ASSET, "video/mp4"
        asset = tmp_path / "upload.mp4"
        _video(asset, "color=blue:s=96x160:r=12", 1)
    form = {"url": "https://www.youtube.com/watch?v=abcdefghijk", "acknowledged": "true",
            "youtube_live_webcam": json.dumps([0.05, 0.05, 0.2, 0.2])}

    async def post(content):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app),
                                     base_url="http://testserver") as client:
            return await client.post("/api/process", data=form,
                                     files={field: (asset.name, content, content_type)})

    invalid = asyncio.run(post(b"not a video"))
    assert invalid.status_code == 400 and f"readable {asset.suffix[1:].upper()}" in invalid.json()["detail"]
    assert not list(Path(api.OUTPUT_DIR).iterdir())
    valid = asyncio.run(post(asset.read_bytes()))
    assert valid.status_code == 200, valid.text
    job_id = valid.json()["job_id"]
    assert (Path(api.OUTPUT_DIR) / job_id / name).read_bytes() == asset.read_bytes()
    assert "--youtube-live-webcam" in api.jobs[job_id]["cmd"]
