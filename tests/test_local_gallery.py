import json
import os
import uuid

import pytest
from fastapi.testclient import TestClient

app_module = pytest.importorskip("app")


def test_local_gallery_lists_only_saved_clips_newest_first(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(app_module, "BILLING_ENABLED", False)

    def render(base, timestamp, *shorts):
        job = tmp_path / str(uuid.uuid4())
        job.mkdir()
        meta = job / f"{base}_metadata.json"
        meta.write_text(json.dumps({"shorts": shorts}), encoding="utf-8")
        os.utime(meta, (timestamp, timestamp))
        return job

    older = render("Older", 1_750_000_000, {})
    (older / "Older_clip_1.mp4").write_bytes(b"clip")
    newer = render("Épisode_[2]", 1_750_000_001,
                   {"video_title_for_youtube_short": "Final round"}, {"video_url": "/videos/source.mp4"}, {})
    clean = newer / "Épisode_[2]_clip_1.mp4"
    clean.write_bytes(b"clean")
    derived = newer / f"subtitled_1_{clean.name}"
    derived.write_bytes(b"edited")
    os.utime(clean, (1_750_000_000, 1_750_000_000))
    (newer / "source.mp4").write_bytes(b"full source")
    (newer / "Épisode_[2]_clip_3.mp4").touch()

    for marker in (app_module._RESUME_FILE, app_module._EXPIRED_MARKER, ".owner"):
        hidden = render("Hidden", 1_750_000_002, {})
        (hidden / "Hidden_clip_1.mp4").write_bytes(b"clip")
        (hidden / marker).touch()

    client = TestClient(app_module.app)
    response = client.get("/api/local-gallery")
    assert response.status_code == 200
    videos = response.json()["videos"]
    assert [v["job_id"] for v in videos] == [newer.name, older.name]
    assert [v["title"] for v in videos] == ["Final round", "Clip 1"]
    path = f"/videos/{newer.name}/subtitled_1_%C3%89pisode_%5B2%5D_clip_1.mp4"
    assert videos[0]["view_url"] == videos[0]["download_url"] == path

    monkeypatch.setattr(app_module, "BILLING_ENABLED", True)
    assert client.get("/api/local-gallery").status_code == 404
