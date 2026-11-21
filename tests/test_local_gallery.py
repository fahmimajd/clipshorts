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


def test_delete_render_removes_its_files_and_saved_job_only(tmp_path, monkeypatch):
    output, uploads = tmp_path / "output", tmp_path / "uploads"
    output.mkdir()
    uploads.mkdir()
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(output))
    monkeypatch.setattr(app_module, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(app_module, "BILLING_ENABLED", False)
    saved_jobs = {}
    monkeypatch.setattr(app_module, "jobs", saved_jobs)

    def render():
        job = output / str(uuid.uuid4())
        job.mkdir()
        (job / "Example_metadata.json").write_text('{"shorts":[{}]}', encoding="utf-8")
        (job / "Example_clip_1.mp4").write_bytes(b"clip")
        (job / "source.mp4").write_bytes(b"source")
        return job

    target, other = render(), render()
    saved_jobs[target.name] = {"status": "completed", "logs": [], "result": {"clips": []}}
    target_upload = uploads / f"{target.name}_upload.mp4"
    others = uploads / f"{other.name}_upload.mp4"
    for upload in (target_upload, others):
        upload.write_bytes(b"upload")

    client = TestClient(app_module.app)
    url = f"/api/local-gallery/{target.name}"
    assert client.delete(url, headers={"Origin": "https://example.invalid",
                                      "Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.delete(url, headers={"Origin": "https://example.invalid"}).status_code == 403
    (target / ".owner").touch()
    assert client.delete(url).status_code == 404
    (target / ".owner").unlink()
    manifest = target / app_module._RESUME_FILE
    manifest.touch()
    assert client.delete(url).status_code == 409
    manifest.unlink()
    monkeypatch.setattr(app_module, "BILLING_ENABLED", True)
    assert client.delete(url).status_code == 404
    monkeypatch.setattr(app_module, "BILLING_ENABLED", False)
    assert target.is_dir() and target_upload.is_file()

    assert client.delete(url, headers={"Origin": "http://testserver",
                                      "Sec-Fetch-Site": "same-origin"}).json() == {"deleted": target.name}
    assert not target.exists() and not target_upload.exists()
    assert (other / "source.mp4").is_file() and others.is_file()
    assert [v["job_id"] for v in client.get("/api/local-gallery").json()["videos"]] == [other.name]
    assert client.get(f"/api/status/{target.name}").status_code == 404


@pytest.mark.skipif(os.name == "nt", reason="Creating a symlink can require a Windows privilege")
def test_delete_render_does_not_follow_a_job_directory_symlink(tmp_path, monkeypatch):
    output = tmp_path / "output"
    output.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    meta = outside / "Example_metadata.json"
    meta.write_text("{}", encoding="utf-8")
    job = output / str(uuid.uuid4())
    job.symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(output))
    monkeypatch.setattr(app_module, "BILLING_ENABLED", False)

    client = TestClient(app_module.app)
    assert client.delete(f"/api/local-gallery/{job.name}").status_code == 404
    assert meta.is_file()
