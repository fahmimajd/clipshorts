"""Per-project logo and ending template, rendered on delivery copies only."""
import base64
from fractions import Fraction
from io import BytesIO
import json
import math
from pathlib import Path
import shutil
import subprocess
from uuid import uuid4


LOGO_ASSET = ".campaign-watermark.png"
MOTION_LOGO_ASSET = ".campaign-watermark.mov"
OUTRO_ASSET = ".campaign-outro.mp4"
ASSETS = ((LOGO_ASSET, "image/png"), (MOTION_LOGO_ASSET, "video/quicktime"), (OUTRO_ASSET, "video/mp4"))
PREFIX = "campaign_"
MAX_BYTES = 512 * 1024
MAX_EDGE = 1080
MAX_VIDEO_BYTES = 25 * 1024 * 1024
MAX_MOTION_LOGO_BYTES = 100 * 1024 * 1024
MAX_VIDEO_SECONDS = 30
MAX_MOTION_LOGO_EDGE = 1920
MAX_OUTRO_EDGE = 4096


def has_assets(directory):
    return any((Path(directory) / name).is_file() for name, _ in ASSETS)


def decode_png(encoded):
    from PIL import Image

    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_BYTES + 2) // 3):
        raise ValueError("Campaign watermark must be a PNG up to 512 KB.")
    try:
        data = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise ValueError("Campaign watermark must be a PNG image.") from exc
    if len(data) > MAX_BYTES:
        raise ValueError("Campaign watermark must be a PNG up to 512 KB.")
    try:
        with Image.open(BytesIO(data), formats=("PNG",)) as image:
            if max(image.size) > MAX_EDGE or image.is_animated:
                raise ValueError(f"Campaign watermark must be a still PNG up to {MAX_EDGE} × {MAX_EDGE} px.")
            rgba = image.convert("RGBA")
            rgba.info.clear()
            out = BytesIO()
            rgba.save(out, format="PNG")
            return out.getvalue()
    except (OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ValueError("Campaign watermark is not a readable PNG image.") from exc


_ASSET_INPUT = ["-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0"]


def _video_info(path, *, asset_format=None):
    info = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", *(_ASSET_INPUT if asset_format else []), "-i", str(path),
        "-show_entries",
        "stream=index,codec_type,width,height,duration,sample_aspect_ratio"
        ":stream_disposition=attached_pic:format=duration:format_tags=major_brand",
        "-of", "json",
    ], text=True, stderr=subprocess.PIPE, timeout=15 if asset_format else 60))
    streams = info.get("streams", ())
    video = next((s for s in streams if s["codec_type"] == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    if video is None or min(video.get("width", 0), video.get("height", 0)) < 2:
        raise ValueError("A playable video stream is required.")
    audio = next((s for s in streams if s["codec_type"] == "audio"), None)
    container = info.get("format", {})
    duration = float(video.get("duration") or container.get("duration") or 0)
    brand = container.get("tags", {}).get("major_brand", "").strip()
    if (not math.isfinite(duration) or duration <= 0
            or (asset_format == "mp4" and (not brand or brand == "qt"))
            or (asset_format == "mov" and brand != "qt")):
        raise ValueError("A playable video with a known duration is required.")
    return video, audio, duration


def save_video_asset(upload, path):
    motion_logo = Path(path).name == MOTION_LOGO_ASSET
    label, asset_format, max_edge = (
        ("Campaign watermark", "mov", MAX_MOTION_LOGO_EDGE) if motion_logo else ("Ending template", "mp4", MAX_OUTRO_EDGE)
    )
    size = upload.seek(0, 2)
    max_bytes = MAX_MOTION_LOGO_BYTES if motion_logo else MAX_VIDEO_BYTES
    if not 0 < size <= max_bytes:
        raise ValueError(f"{label} must be a {asset_format.upper()} video up to {max_bytes // 1024**2} MB.")
    upload.seek(0)
    with open(path, "wb") as target:
        shutil.copyfileobj(upload, target)
    try:
        video, _, duration = _video_info(path, asset_format=asset_format)
    except (ValueError, subprocess.SubprocessError) as exc:
        raise ValueError(f"{label} is not a readable {asset_format.upper()} video.") from exc
    if duration > MAX_VIDEO_SECONDS or max(video["width"], video["height"]) > max_edge:
        raise ValueError(f"{label} must be up to {MAX_VIDEO_SECONDS} seconds and {max_edge} px per side.")


def _append_graph(body, clip, ending, outro_index):
    video, audio, duration = clip
    end_video, end_audio, end_duration = ending
    w, h = video["width"], video["height"]
    try:
        sar = Fraction(video.get("sample_aspect_ratio", "").replace(":", "/"))
    except (ValueError, ZeroDivisionError):
        sar = Fraction(1)
    if sar <= 0:
        sar = Fraction(1)
    dar = f"(dar*{sar.denominator}/{sar.numerator})"
    graph = [
        f"{body}setpts=PTS-STARTPTS,setsar={sar}[v0]",
        f"[{outro_index}:{end_video['index']}]"
        f"scale=w='max(2,trunc(min({w},{h}*{dar})/2)*2)':"
        f"h='max(2,trunc(min({h},{w}/{dar})/2)*2)',"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar={sar},setpts=PTS-STARTPTS[v1]",
    ]
    if audio is None and end_audio is None:
        return graph + ["[v0][v1]concat=n=2:v=1:a=0[v]"], False
    for label, stream, index, seconds in (
        ("a0", audio, 0, duration), ("a1", end_audio, outro_index, end_duration)
    ):
        if stream is None:
            graph.append(f"anullsrc=r=48000:cl=stereo:d={seconds:.6f}[{label}]")
        else:
            graph.append(
                f"[{index}:{stream['index']}]aformat=sample_rates=48000:channel_layouts=stereo,"
                f"apad,atrim=duration={seconds:.6f},asetpts=PTS-STARTPTS[{label}]")
    return graph + ["[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"], True


def render(video_path, *, live_banner=False):
    video = Path(video_path)
    logo = video.with_name(MOTION_LOGO_ASSET)
    motion_logo = logo.is_file()
    if not motion_logo:
        logo = video.with_name(LOGO_ASSET)
    outro = video.with_name(OUTRO_ASSET)
    has_logo, has_outro = logo.is_file(), outro.is_file()
    if not (has_logo or has_outro) or (video.name.startswith(PREFIX) and
                                       video.with_name(video.name[len(PREFIX):]).is_file()):
        return video_path

    import gpu_decode
    from ffmpeg_utils import QUALITY, video_encode_args

    clip = _video_info(video)
    width, height = clip[0]["width"], clip[0]["height"]
    dest = video.with_name(PREFIX + video.name)
    tmp = video.with_name(f".campaign-{uuid4().hex}.mp4")
    inputs = ["-i", str(video)]
    graph = []
    body = "[0:v]"
    if has_logo:
        if motion_logo:
            # Decoder padding can exceed the displayed dimensions checked on upload.
            inputs += [*_ASSET_INPUT, "-max_pixels", str(2048 ** 2), "-an", "-stream_loop", "-1"]
        inputs += ["-i", str(logo)]
        output = "[body]" if has_outro else "[v]"
        if live_banner:
            from layout_ranges import live_banner_slot
            banner_y, seam = live_banner_slot(height)
            max_w, max_h = max(1, 2 * round(width * 0.94 / 2)), seam - banner_y
            y = f"{seam}-h"
        else:
            max_w, max_h = width // 4, height // 8
            y = "H*0.06"
        logo_source = "[1:V:0]setpts=PTS-STARTPTS," if motion_logo else "[1:v]"
        shortest = ":shortest=1" if motion_logo else ""
        graph += [
            f"{logo_source}format=rgba,scale=w='max(1,min({max_w},{max_h}*dar))':"
            f"h='max(1,min({max_h},{max_w}/dar))'[logo]",
            f"{body}[logo]overlay=x=(W-w)/2:y={y}{shortest}{output}",
        ]
        body = output
    if has_outro:
        inputs += [*_ASSET_INPUT, "-max_pixels", str(MAX_OUTRO_EDGE ** 2),
                   "-t", str(MAX_VIDEO_SECONDS), "-i", str(outro)]
        join, has_audio = _append_graph(body, clip, _video_info(outro, asset_format="mp4"), 2 if has_logo else 1)
        graph += join
        audio_args = ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] if has_audio else []
        video_timing = ["-fps_mode", "vfr", "-enc_time_base", "1:90000"]
    else:
        video_timing = []
        audio_args = ["-map", "0:a?", "-c:a", "copy"]
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
           *(["-xerror"] if motion_logo or has_outro else []),
           *inputs, "-filter_complex", ";".join(graph), "-map", "[v]",
           *video_timing, *audio_args, "-pix_fmt", "yuv420p", *video_encode_args(QUALITY),
           "-movflags", "+faststart", str(tmp)]
    try:
        result = gpu_decode.run(
            lambda on_gpu: gpu_decode.on_card(cmd, str(video)) if on_gpu else cmd,
            lambda args: subprocess.run(args, capture_output=True, timeout=1800),
            path=video_path)
        if result.returncode or not tmp.is_file() or not tmp.stat().st_size:
            raise RuntimeError(f"Campaign render failed: {result.stderr.decode(errors='replace')[-300:]}")
        tmp.replace(dest)
        return str(dest)
    finally:
        tmp.unlink(missing_ok=True)
