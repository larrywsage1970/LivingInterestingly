import asyncio
import json

import httpx

from app.snapshot import build
from tests.conftest import mock_transport


def run_build(tmp_path, transport, previous_url=None):
    async def go():
        async with httpx.AsyncClient(transport=transport) as c:
            return await build(tmp_path / "site", previous_url, client=c)
    return asyncio.run(go())


def test_builds_static_site_with_snapshot(tmp_path):
    summary = run_build(tmp_path, mock_transport("nws_alerts_warning.json"))
    site = tmp_path / "site"
    assert (site / "index.html").exists() and (site / ".nojekyll").exists()
    assert 'content="static"' in (site / "index.html").read_text()
    data = json.loads((site / "api" / "status.json").read_text())
    assert data["mode"] == "static" and data["stale_after_s"] > 0
    assert data["banner"]["color"] == "red"
    assert summary["stow-44224"]["feeds"]["nws_alerts"] == "fresh"


def test_failing_feed_keeps_last_good_from_previous_snapshot(tmp_path):
    # First run publishes good data; second run has NWS alerts down.
    run_build(tmp_path / "a", mock_transport("nws_alerts_warning.json"))
    previous = (tmp_path / "a" / "site" / "api" / "status-stow-44224.json").read_text()

    t = mock_transport("nws_alerts_empty.json", fail=["/alerts"])
    base = t.handle_request

    def handler(req):
        if req.url.host == "pages.example":
            return httpx.Response(200, text=previous)
        return base(req)

    summary = run_build(tmp_path / "b", httpx.MockTransport(handler), "https://pages.example/repo/")
    data = json.loads((tmp_path / "b" / "site" / "api" / "status.json").read_text())
    card = data["cards"]["nws_alerts"]
    assert card["state"] == "failing" and card["last_good_at"] and card["items"]
    assert data["banner"]["color"] in ("red", "gray")
    assert summary["stow-44224"]["feeds"]["nws_alerts"] == "failing"


def test_first_deploy_without_previous_is_fine(tmp_path):
    t = mock_transport("nws_alerts_empty.json")
    base = t.handle_request
    handler = lambda req: httpx.Response(404) if req.url.host == "pages.example" else base(req)
    run_build(tmp_path, httpx.MockTransport(handler), "https://pages.example/repo/")
    assert (tmp_path / "site" / "api" / "status.json").exists()
