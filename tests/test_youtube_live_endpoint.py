import asyncio

import httpx
import pytest

app_module = pytest.importorskip("app")


def _request(method, path, **kwargs):
    async def send():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_module.app),
                                     base_url="http://testserver") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(send())


@pytest.mark.parametrize("url, box, detail", [
    ("https://www.youtube.com/watch?v=abcdefghijk", [0, 0, 1, 1], "gameplay"),
    ("https://www.youtube.com/watch?v=abcdefghijk", [0, 0.9, 0.2, 0.2], "within"),
    ("https://example.com/watch?v=abcdefghijk", [0, 0, 0.2, 0.2], "YouTube"),
])
def test_live_submission_rejects_invalid_source_or_crop(url, box, detail):
    response = _request("POST", "/api/process", json={
        "url": url, "acknowledged": True, "youtube_live_webcam": box,
    })
    assert response.status_code == 400
    assert detail in response.json()["detail"]


def test_preview_accepts_only_youtube_sources():
    response = _request("GET", "/api/youtube-live/preview", params={
        "url": "http://127.0.0.1/watch?v=abcdefghijk",
    })
    assert response.status_code == 400
    assert "completed YouTube livestream" in response.json()["detail"]
