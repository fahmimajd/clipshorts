import time
from concurrent.futures import Future

import pytest

import transcribe_backends as asr
from subtitles import generate_srt

main = pytest.importorskip("main")


DURATION = 120.0
CAPTIONS = {
    "language": "id", "duration": DURATION,
    "segments": [
        {"start": float(start), "dur": 4.0,
         "text": "Bagian ini berisi cerita dan penjelasan yang cukup panjang."}
        for start in range(0, 120, 5)
    ],
}


def lookup(value):
    result = Future()
    result.set_result(value)
    return result, time.monotonic()


def test_selects_from_youtube_but_subtitles_from_padded_whisper_audio(tmp_path, monkeypatch):
    transcript = main._wait_youtube_captions(lookup(CAPTIONS), DURATION)
    assert transcript["segments"][8]["start"] == 40
    assert transcript["segments"][8]["end"] == 44
    calls = []

    def model(_client, _model, prompt, schema):
        if schema is main.gemini_worker.ScoreResponse:
            return {"windows": [{"id": "window_001", "score": 98}]}, None
        assert "[40.0s] Bagian ini" in prompt
        return {"shorts": [{"start": 40, "end": 64, "source_window_id": "window_001"}]}, None

    monkeypatch.setattr(main.llm_backend, "active", lambda: True)
    monkeypatch.setattr(main, "_run_gemini_stage", model)
    monkeypatch.setenv("CLIP_TARGET_MIN", "1")
    monkeypatch.setenv("CLIP_TARGET_MAX", "1")
    monkeypatch.setenv("CLIP_MIN_SECONDS", "15")
    monkeypatch.setenv("CLIP_MAX_SECONDS", "60")
    monkeypatch.setattr(main, "transcribe_video", lambda _: pytest.fail("unexpected full ASR"))
    monkeypatch.setattr(asr, "ASR_HOST_SLOTS", 0)
    monkeypatch.setattr(asr, "release_models", lambda: None)
    monkeypatch.setattr(asr.subprocess, "run", lambda cmd, **_: calls.append(cmd))
    monkeypatch.setattr(asr, "_transcribe_with_whisper", lambda _: {
        "language": "id", "segments": [{"words": [
            {"word": " Kalimat Whisper", "start": 3.4, "end": 4.0},
            {"word": " selesai.", "start": 26.1, "end": 26.6},
        ]}],
    })

    clips, words = main._select_or_transcribe("source.mp4", DURATION, str(tmp_path), None, transcript)
    assert [(cmd[cmd.index("-ss") + 1], cmd[cmd.index("-t") + 1]) for cmd in calls] == [
        ("37.000", "30.000")]
    clip = clips["shorts"][0]
    assert (clip["start"], clip["end"]) == (40.05, 64.05)
    out = tmp_path / "clip.srt"
    assert generate_srt(words, clip["start"], clip["end"], out)
    srt = out.read_text(encoding="utf-8-sig")
    assert "Kalimat Whisper" in srt and "selesai." in srt
    assert "Bagian ini" not in srt
    assert not (tmp_path / main.TRANSCRIPT_CHECKPOINT).exists()


@pytest.mark.parametrize("mode", ["missing", "incomplete", "duration_mismatch", "no_clips"])
def test_uses_full_asr_when_youtube_captions_are_unusable(tmp_path, monkeypatch, mode):
    data = {"missing": None, "incomplete": {**CAPTIONS, "segments": CAPTIONS["segments"][:5]},
            "duration_mismatch": {**CAPTIONS, "duration": 200}, "no_clips": CAPTIONS}[mode]
    captions = main._wait_youtube_captions(lookup(data), DURATION)
    full = {"language": "id", "segments": [{"start": 0, "end": 120, "text": "Full ASR"}]}

    def pick(*_):
        assert mode == "no_clips"
        return None

    monkeypatch.setattr(main, "get_viral_clips", pick)
    monkeypatch.setattr(main, "transcribe_video", lambda _: full)
    assert main._select_or_transcribe("source.mp4", DURATION, str(tmp_path), None, captions) == (None, full)
    assert main.load_transcript_checkpoint(str(tmp_path), "source.mp4", DURATION) == full
