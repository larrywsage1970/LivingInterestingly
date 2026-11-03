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


def test_ipaws_query_uses_verified_geo_syntax_and_excludes_nws(loc):
    t = mock_transport()

    async def go():
        async with httpx.AsyncClient(transport=t) as c:
            return await fema.fetch_ipaws(c, loc)

    res = asyncio.run(go())
    assert res["ok"]
    flt = t.seen[0].url.params["$filter"]
    assert "searchGeometry eq null" in t.seen[1].url.params["$filter"]
    events = [i["event"] for i in res["items"]]
    assert "Other County Notice" not in events          # other county dropped
    assert "Local Area Emergency" in events             # matched by county name
    assert "Duplicate Of Geo Record" not in events      # de-duplicated by identifier
    assert "geography'POINT(-81.4404 41.1595)'" in flt
    assert "sender ne 'w-nws.webmaster@noaa.gov'" in flt


def test_ipaws_area_desc_read_from_areas_field():
    items = fema.parse_ipaws(fixture("fema_ipaws.json"), NOW)
    assert "Summit County, OH" in items[0]["raw_excerpt"]
