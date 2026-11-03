import asyncio
import json

import httpx
import pytest

from app import notify
from app.snapshot import build
from tests.conftest import mock_transport


@pytest.mark.parametrize("prev,new,expect", [
    ("green", "amber", True), ("green", "red", True), ("amber", "red", True), ("red", "amber", True),
    ("amber", "green", True), ("red", "green", True),
    ("green", "green", False), ("amber", "amber", False),
    ("green", "gray", False), ("red", "gray", False), ("gray", "green", False),
    (None, "red", False),   # first deploy: no previous snapshot, no page
])
def test_decide(prev, new, expect):
    assert notify.decide(prev, new) is expect


def payload(color, rule="SYNTHETIC rule"):
    return {"banner": {"color": color, "rule": rule}}


def test_push_sends_title_priority_and_link(monkeypatch):
    monkeypatch.setenv("NTFY_TOPIC", "grid-test-topic")
    sent = []
    client = httpx.Client(transport=httpx.MockTransport(lambda r: sent.append(r) or httpx.Response(200)))
    msg = notify.maybe_notify(payload("green"), payload("red", "Winter Storm Warning active"),
                              "Stow, OH 44224", "https://example.github.io/grid/", client)
    assert msg.startswith("pushed (green -> red)")
    req = sent[0]
    assert str(req.url) == "https://ntfy.sh/grid-test-topic"
    assert req.headers["Title"] == "GRID Stow, OH 44224: RED - WARNING"
    assert req.headers["Priority"] == "5"
    assert req.headers["Click"] == "https://example.github.io/grid/"
    assert req.content == b"Winter Storm Warning active"


def test_no_topic_means_no_request(monkeypatch):
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    client = httpx.Client(transport=httpx.MockTransport(lambda r: pytest.fail("should not send")))
    assert "NTFY_TOPIC is not set" in notify.maybe_notify(payload("green"), payload("amber"), "X", None, client)


def test_snapshot_pushes_on_change_and_injects_ask_url(tmp_path, monkeypatch):
    monkeypatch.setenv("NTFY_TOPIC", "grid-test-topic")
    monkeypatch.setenv("SGW_ASK_URL", "https://grid-ask.example.workers.dev")
    monkeypatch.setenv("SGW_VERSION", "2030.01.10-abc1234")
    previous = json.dumps({"banner": {"color": "green"}, "cards": {}})
    base = mock_transport("nws_alerts_warning.json").handle_request

    def handler(req):
        if req.url.host == "pages.example":
            return httpx.Response(200, text=previous)
        return base(req)

    sent = []
    nclient = httpx.Client(transport=httpx.MockTransport(lambda r: sent.append(r) or httpx.Response(200)))

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await build(tmp_path / "site", "https://pages.example/repo/", client=c, notify_client=nclient)

    summary = asyncio.run(go())
    assert summary["stow-44224"]["color"] == "red"
    assert summary["stow-44224"]["push"].startswith("pushed (green -> red)")
    assert sent and sent[0].headers["Click"] == "https://pages.example/repo/"
    html = (tmp_path / "site" / "index.html").read_text()
    assert '<meta name="sgw-ask-url" content="https://grid-ask.example.workers.dev">' in html
    assert '<meta name="sgw-version" content="2030.01.10-abc1234">' in html
    status = json.loads((tmp_path / "site" / "api" / "status.json").read_text())
    assert status["app_version"] == "2030.01.10-abc1234"


def test_send_test_alert(monkeypatch):
    monkeypatch.setenv("NTFY_TOPIC", "grid-test-topic")
    sent = []
    client = httpx.Client(transport=httpx.MockTransport(lambda r: sent.append(r) or httpx.Response(200)))
    assert notify.send_test("https://example.github.io/grid/", client) == "test sent: HTTP 200"
    assert sent[0].headers["Title"] == "GRID test" and b"Test alert" in sent[0].content


def test_send_test_without_topic(monkeypatch):
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    assert notify.send_test() == "test not sent: NTFY_TOPIC is not set"
