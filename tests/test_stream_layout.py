import base64
from io import BytesIO
import json
import shutil
import subprocess

import pytest

from PIL import Image

import campaign
import camera_inset
import gpu_render
import layout_ranges
import reframe_v2
import subtitles


def test_manual_box_normalizes_numbers_and_allows_edges():
    box = camera_inset.normalize_manual_box((0, 0.99, 0.01, 0.01))
    assert box == [0.0, 0.99, 0.01, 0.01]
    assert all(type(v) is float for v in box)


@pytest.mark.parametrize("box, error", [
    ("[0,0,0.2,0.2]", "must be"),
    ([0, 0, 0.2], "must be"),
    ([False, 0, 0.2, 0.2], "finite numbers"),
    (["0", 0, 0.2, 0.2], "finite numbers"),
    ([0, float("nan"), 0.2, 0.2], "finite numbers"),
    ([0, float("inf"), 0.2, 0.2], "finite numbers"),
    ([0, -0.1, 0.2, 0.2], "finite numbers"),
    ([0, 0, 0.009, 0.2], "at least 1%"),
    ([0, 0.9, 0.2, 0.2], "within the source frame"),
])
def test_invalid_manual_box(box, error):
    with pytest.raises(ValueError, match=error):
        camera_inset.normalize_manual_box(box)


def test_corner_box_keeps_the_largest_gameplay_rectangle():
    graph = reframe_v2._stream_filtergraph(1920, 1080, 1080, 1920,
                                          [0.80, 0.75, 0.20, 0.25])
    game, webcam = gpu_render.layers_from_graph(graph, 1920, 1080, 1080, 1920)
    assert game["src"] == [0, 0, 1536, 1080]
    assert webcam["src"] == [1576, 810, 304, 270]
    assert game["dst"] == [0, 200, 1080, 760]
    assert webcam["dst"] == [0, 960, 1080, 960]


def test_fractional_box_does_not_leak_into_gameplay():
    graph = reframe_v2._stream_filtergraph(1280, 720, 1080, 1920,
                                          [0.44, 0.36, 0.13, 0.28])
    game, webcam = gpu_render.layers_from_graph(graph, 1280, 720, 1080, 1920)
    assert webcam["src"] == [562, 284, 168, 150]
    gx, gy, gw, gh = game["src"]
    wx, wy, ww, wh = webcam["src"]
    assert gx + gw <= wx or wx + ww <= gx or gy + gh <= wy or wy + wh <= gy
    _, _, dw, dh = game["dst"]
    assert abs(dw - dh * gw / gh) <= 2
    _, _, dw, dh = webcam["dst"]
    assert abs(wh - ww * dh / dw) <= 1  # Round the crop to even source pixels before scaling.


def test_box_covering_the_whole_frame_leaves_no_gameplay():
    with pytest.raises(ValueError, match="gameplay"):
        reframe_v2._stream_filtergraph(1280, 720, 1080, 1920, [0, 0, 1, 1])


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
                    reason="ffmpeg/ffprobe not installed")
@pytest.mark.parametrize("watermark", [None, "png", "mov"])
def test_stream_render_stacks_gameplay_and_webcam_and_keeps_audio(tmp_path, monkeypatch, watermark):
    cv2 = pytest.importorskip("cv2")

    monkeypatch.setattr(gpu_render, "ENABLED", False)
    monkeypatch.setattr(reframe_v2.gpu_decode, "RENDER", False)
    monkeypatch.setenv("FFMPEG_ENCODER", "x264")
    source, output = tmp_path / "stream.mp4", tmp_path / "clip.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "color=c=blue:s=320x180:r=8:d=0.5,drawbox=x=240:y=120:w=80:h=60:color=red:t=fill",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
        "-c:v", "libx264", "-c:a", "aac", str(source),
    ], check=True, timeout=30)

    if watermark == "png":
        upload = BytesIO()
        Image.new("RGBA", (1080, 176), "lime").save(upload, "PNG")
        encoded = base64.b64encode(upload.getvalue()).decode("ascii")
        (tmp_path / campaign.LOGO_ASSET).write_bytes(campaign.decode_png(encoded))
    elif watermark == "mov":
        subprocess.run([
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
            "nullsrc=s=108x18:r=8:d=0.5,format=gbrap,geq=r=0:g=255:b=0:a='if(lt(X,54),255,0)'",
            "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le",
            str(tmp_path / campaign.MOTION_LOGO_ASSET),
        ], check=True, timeout=30)

    assert reframe_v2.render_stream(source, output, [0.75, 2 / 3, 0.25, 1 / 3])
    metadata = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name",
        "-of", "json", str(output),
    ], timeout=30))
    assert {s["codec_type"]: s["codec_name"] for s in metadata["streams"]} == {
        "video": "h264", "audio": "aac",
    }
    ranges = layout_ranges.read(str(output))
    if watermark:
        ass, captioned = tmp_path / "text.ass", tmp_path / "captioned.mp4"
        words = {"segments": [{"words": [{"word": "TEST", "start": 0, "end": 0.5}]}]}
        assert subtitles.generate_ass(words, 0, 0.5, ass, font_name="Anton", fontsize=44,
                                      highlight_color="#FFFFFF",
                                      live_banner=layout_ranges.has_live_banner(ranges))
        subtitles.burn_subtitles(str(output), str(ass), str(captioned))
        output = campaign.render(str(captioned), live_banner=layout_ranges.has_live_banner(ranges))
    cap = cv2.VideoCapture(str(output))
    try:
        ok, frame = cap.read()
    finally:
        cap.release()
    assert ok and frame.shape[:2] == (1920, 1080)
    if watermark:
        game_pixel, cam_y = frame[980, 90], 1152
        logo_pixel = frame[1070, 90]
        assert logo_pixel[1] > 200 and logo_pixel[2] < 40
        if watermark == "mov":
            # Check the gameplay behind the transparent half, not just beside the logo.
            blue, green, red = frame[1070, 750]
            assert blue > 200 and max(green, red) < 40
        white = (frame[720:1000].min(axis=2) > 220).nonzero()
        assert len(white[0]) > 100 and abs(white[1].mean() - 540) < 20
        assert white[0].max() + 720 < 988
    else:
        game_pixel, cam_y = frame[959, 540], 960
        assert layout_ranges.split_ranges(ranges) == [(0.0, 0.5)]
    assert game_pixel[0] > 200 and game_pixel[2] < 40
    for col in (2, 540, 1077):
        assert frame[cam_y, col, 2] > 200 and frame[cam_y, col, 0] < 40
