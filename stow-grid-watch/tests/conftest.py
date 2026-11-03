import json
from datetime import datetime
from pathlib import Path

import httpx
import pytest

from app.config import BASE_DIR, load_locations

FIX = Path(__file__).parent / "fixtures"
NOW = datetime.fromisoformat("2030-01-10T12:00:00-05:00")


def fixture(name: str) -> dict:
    return json.loads((FIX / name).read_text())


@pytest.fixture
def loc():
    _, locs = load_locations(BASE_DIR / "locations.json")
    return locs["stow-44224"]


def mock_transport(alerts="nws_alerts_empty.json", fail=None):
    """Routes requests to fixtures. `fail` = substrings of paths that return HTTP 503."""
    seen = []
    fail = fail if fail is not None else []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        p = req.url.path
        if any(f in p for f in fail):
            return httpx.Response(503, text="unavailable")
        if p == "/alerts/active":
            return httpx.Response(200, json=fixture(alerts))
        if p.startswith("/points/"):
            return httpx.Response(200, json=fixture("nws_points.json"))
        if p.endswith("/forecast"):
            return httpx.Response(200, json=fixture("nws_forecast.json"))
        if p == "/category/operations/feed/":
            return httpx.Response(200, text=(FIX / "pjm_insidelines.xml").read_text(),
                                  headers={"content-type": "application/rss+xml"})
        if p.endswith("/region-data/data/"):
            return httpx.Response(200, json=fixture("eia_pjm.json"))
        if p.endswith("/DisasterDeclarationsSummaries"):
            return httpx.Response(200, json=fixture("fema_declarations.json"))
        if p.endswith("/IpawsArchivedAlerts"):
            if "searchGeometry eq null" in req.url.params.get("$filter", ""):
                return httpx.Response(200, json=fixture("fema_ipaws_nogeo.json"))
            return httpx.Response(200, json=fixture("fema_ipaws.json"))
        return httpx.Response(404)

    t = httpx.MockTransport(handler)
    t.seen = seen
    t.fail = fail
    return t
