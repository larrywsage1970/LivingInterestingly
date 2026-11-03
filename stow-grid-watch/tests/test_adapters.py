import asyncio

import httpx

from app.adapters import fema, nws
from app.adapters.base import run
from app.sources import BY_ID
from tests.conftest import NOW, fixture, mock_transport


def test_nws_alerts_parse_warning():
    items = nws.parse_alerts(fixture("nws_alerts_warning.json"))
    assert len(items) == 1
    it = items[0]
    assert it["kind"] == "alert" and it["event"] == "Winter Storm Warning"
    assert it["severity"] == "Moderate"          # copied, not invented
    assert it["url"].startswith("https://api.weather.gov/alerts/")


def test_nws_alerts_drop_test_messages():
    items = nws.parse_alerts(fixture("nws_alerts_with_test_msg.json"))
    assert [i["event"] for i in items] == ["Winter Weather Advisory"]


def test_nws_forecast_48h_window_and_lows():
    items = nws.parse_forecast(fixture("nws_forecast.json"), "https://x/forecast", NOW)
    names = [i["period"] for i in items]
    assert "Sunday Night" not in names            # starts beyond 48h
    tonight = next(i for i in items if i["period"] == "Tonight")
    assert tonight["is_low"] and tonight["temperature"] == 8
    assert "snow" in tonight["hazard_mentions"]
    assert all(i["kind"] == "forecast" and i["severity"] is None for i in items)


def test_fema_declarations_active_flag():
    items = fema.parse_declarations(fixture("fema_declarations.json"), NOW)
    assert [i["active"] for i in items] == [True, False]
    assert items[0]["url"] == "https://www.fema.gov/disaster/9901"


def test_ipaws_filters_nws_tests_cancels_and_expired():
    items = fema.parse_ipaws(fixture("fema_ipaws.json"), NOW)
    assert [i["event"] for i in items] == ["Boil Water Notice", "Shelter In Place Warning"]
    assert all(i["origin"] == "ipaws" for i in items)


def test_fetch_sends_geojson_accept_and_point(loc):
    t = mock_transport("nws_alerts_warning.json")

    async def go():
        async with httpx.AsyncClient(transport=t) as c:
            return await nws.fetch_alerts(c, loc)

    res = asyncio.run(go())
    assert res["ok"] and res["source"] == "nws_alerts" and res["fetched_at"]
    req = t.seen[0]
    assert req.headers["accept"] == "application/geo+json"
    assert req.url.params["point"] == "41.1595,-81.4404"


def test_adapter_failure_becomes_data_not_crash(loc):
    t = mock_transport(fail=("/alerts",))

    async def go():
        async with httpx.AsyncClient(transport=t) as c:
            return await run(BY_ID["nws_alerts"], c, loc)

    res = asyncio.run(go())
    assert res["ok"] is False and "503" in res["error"] and res["items"] == []
