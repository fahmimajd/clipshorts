"""The OpenAI-compatible moment-picker backend (llm_backend.py).

Self-hosters asked for a pipeline that never calls Google. The transcript
passes go to any /chat/completions server when LLM_BASE_URL is set; these
tests pin the contract main.py relies on: same (parsed, cost) shape as the
Gemini stage, schema validation, and the response_format fallback ladder.
"""
import json

import httpx
import pytest

import gemini_worker
import llm_backend
import ssrf_guard


@pytest.fixture
def local(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "http://llm.test/v1")
    monkeypatch.setenv("LLM_MODEL", "qwen2.5:14b")
    monkeypatch.delenv("LLM_PROVIDER", raising=False)


def _serve(handler, monkeypatch):
    """Route llm_backend's httpx client through an in-process handler."""
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(llm_backend, "_client",
                        lambda **kw: httpx.Client(transport=transport, **kw))


def _completion(payload, usage=None):
    return httpx.Response(200, json={
        "choices": [{"message": {"role": "assistant", "content": json.dumps(payload)}}],
        "usage": usage or {"prompt_tokens": 120, "completion_tokens": 40},
    })


# --- activation -----------------------------------------------------------

def test_inactive_without_a_base_url(monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    assert llm_backend.active() is False
    assert llm_backend.describe() is None


def test_base_url_alone_activates_and_describes(local):
    assert llm_backend.active() is True
    assert llm_backend.describe() == {
        "provider": "openai", "model": "qwen2.5:14b", "baseUrl": "http://llm.test/v1"}


def test_explicit_gemini_provider_wins_over_base_url(local, monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    assert llm_backend.active() is False


@pytest.mark.parametrize("base", [
    "http://example.com/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1?token=value",
    "https://example.com/v1/chat/completions",
])
def test_dashboard_provider_rejects_unsafe_base_urls(base):
    with pytest.raises(ValueError, match="public HTTPS"):
        llm_backend.remote_job_env(base, "provider/model", "")


def test_dashboard_provider_sends_its_model_and_key_without_assuming_price(monkeypatch):
    monkeypatch.setattr(llm_backend, "assert_public_url", lambda url: url)
    env = llm_backend.remote_job_env("https://example.com/api/v1/", "provider/model", "test-key")
    for name, value in env.items():
        monkeypatch.setenv(name, value)

    def handler(request):
        assert str(request.url) == "https://example.com/api/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-key"
        assert json.loads(request.content)["model"] == "provider/model"
        assert ssrf_guard.active()
        return _completion({"windows": []})

    _serve(handler, monkeypatch)
    assert llm_backend.generate_json("score windows", gemini_worker.ScoreResponse) == ({"windows": []}, None)


def test_dashboard_provider_does_not_echo_upstream_error_body(local, monkeypatch):
    monkeypatch.setenv("LLM_REMOTE_ONLY", "1")
    _serve(lambda r: httpx.Response(401, text="upstream echoed a secret"), monkeypatch)
    with pytest.raises(RuntimeError, match="HTTP 401") as error:
        llm_backend.generate_json("score windows", gemini_worker.ScoreResponse)
    assert "upstream echoed a secret" not in str(error.value)


# --- generate_json ---------------------------------------------------------

def test_returns_validated_payload_and_zero_cost(local, monkeypatch):
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        seen["auth"] = request.headers.get("authorization")
        return _completion({"windows": [{"id": "w0", "start": 0, "end": 90, "score": 88, "reason": "hook"}]})

    _serve(handler, monkeypatch)
    parsed, cost = llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)

    assert seen["url"] == "http://llm.test/v1/chat/completions"
    assert seen["body"]["model"] == "qwen2.5:14b"
    assert seen["body"]["response_format"]["type"] == "json_schema"
    assert seen["auth"] == "Bearer ollama"  # documented placeholder when no key is set
    assert parsed["windows"][0]["score"] == 88
    assert cost["total_cost"] == 0.0 and cost["local"] is True
    assert cost["input_tokens"] == 120 and cost["output_tokens"] == 40


def test_falls_back_to_json_object_when_schema_mode_is_rejected(local, monkeypatch):
    formats = []

    def handler(request):
        body = json.loads(request.content)
        fmt = (body.get("response_format") or {}).get("type")
        formats.append(fmt)
        if fmt == "json_schema":
            return httpx.Response(400, json={"error": {"message": "response_format json_schema not supported"}})
        return _completion({"windows": []})

    _serve(handler, monkeypatch)
    parsed, _ = llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)
    assert formats == ["json_schema", "json_object"]
    assert parsed == {"windows": []}


def test_code_fenced_json_is_accepted(local, monkeypatch):
    """Small models wrap the object in ```json fences even when told not to."""
    def handler(request):
        text = "```json\n" + json.dumps({"windows": []}) + "\n```"
        return httpx.Response(200, json={"choices": [{"message": {"content": text}}], "usage": {}})

    _serve(handler, monkeypatch)
    parsed, _ = llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)
    assert parsed == {"windows": []}


def test_schema_violation_raises_instead_of_leaking_into_the_pipeline(local, monkeypatch):
    _serve(lambda r: _completion({"windows": [{"id": "w0"}]}), monkeypatch)
    with pytest.raises(Exception) as exc:
        llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)
    assert "validation error" in str(exc.value)


def test_server_errors_surface_with_status_and_url(local, monkeypatch):
    _serve(lambda r: httpx.Response(503, text="loading model"), monkeypatch)
    with pytest.raises(RuntimeError) as exc:
        llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)
    assert "503" in str(exc.value) and "loading model" in str(exc.value)


# --- main.py routing (needs the heavy deps; skipped on minimal CI) ------------

def test_stage_routes_to_local_backend_and_retries_transient(local, monkeypatch):
    main = pytest.importorskip("main")
    monkeypatch.setattr(main.time, "sleep", lambda *_: None)
    calls = {"n": 0}

    def fake_generate(prompt, schema, model=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("ConnectError: connection refused")
        return {"windows": [{"id": "w0", "start": 0, "end": 1, "score": 50, "reason": ""}]}, {"total_cost": 0.0}

    monkeypatch.setattr(llm_backend, "generate_json", fake_generate)
    parsed, cost = main._run_gemini_stage(None, "qwen2.5:14b", "prompt", gemini_worker.ScoreResponse)
    assert calls["n"] == 2
    assert parsed["windows"][0]["score"] == 50
    assert cost["total_cost"] == 0.0


def test_score_batch_shrinks_for_local_models(local, monkeypatch):
    main = pytest.importorskip("main")
    monkeypatch.delenv("LLM_SCORE_BATCH", raising=False)
    assert main.score_batch_size() == 3
    monkeypatch.setenv("LLM_SCORE_BATCH", "5")
    assert main.score_batch_size() == 5
    monkeypatch.delenv("LLM_BASE_URL")
    monkeypatch.delenv("LLM_SCORE_BATCH")
    assert main.score_batch_size() == 8
