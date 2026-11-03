import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import Store
from tests.conftest import mock_transport


def client(alerts="nws_alerts_warning.json", fail=None):
    http = httpx.AsyncClient(transport=mock_transport(alerts, fail))
    return TestClient(create_app(store=Store(":memory:"), client=http, poll=False))


def test_health_and_static():
    with client() as c:
        assert c.get("/api/health").json()["ok"] is True
        assert "<title>GRID</title>" in c.get("/").text
        assert c.get("/manifest.webmanifest").status_code == 200


def test_before_any_fetch_banner_is_gray():
    with client() as c:
        assert c.get("/api/status").json()["banner"]["color"] == "gray"


def test_refresh_then_status_every_item_has_source_and_time():
    with client() as c:
        body = c.post("/api/refresh").json()
        assert body["banner"]["color"] == "red"
        for card in body["cards"].values():
            assert card["label"] and card["last_good_at"] and card["home_url"].startswith("https://")
            for it in card["items"]:
                assert it["url"].startswith("https://"), it


def test_failing_feed_shows_last_good_not_green():
    t = mock_transport("nws_alerts_empty.json")
    app = create_app(store=Store(":memory:"), client=httpx.AsyncClient(transport=t),
                     poll=False, refresh_min_interval_s=0)
    with TestClient(app) as c:
        first = c.post("/api/refresh").json()
        assert first["cards"]["nws_alerts"]["state"] == "fresh"
        t.fail.append("/alerts")                      # NWS alerts goes down
        body = c.post("/api/refresh").json()
        assert body["banner"]["color"] in ("gray", "red")  # never green/amber with a failing required feed
        assert body["banner"]["color"] != "green"
        card = body["cards"]["nws_alerts"]
        assert card["state"] == "failing" and card["last_good_at"] and card["error"]


def test_unknown_location_404():
    with client() as c:
        assert c.get("/api/status?location=nowhere").status_code == 404
