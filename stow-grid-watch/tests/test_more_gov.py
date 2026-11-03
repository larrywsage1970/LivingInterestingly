import asyncio
from datetime import datetime, timezone

import httpx

from app import status
from app.adapters import gov_extra, noaa
from app.sources import BY_ID
from tests.conftest import FIX, NOW, fixture, mock_transport
from tests.test_status import feeds, res


def compute(loc, extra):
    fs = feeds()
    for sid, items in extra.items():
        r = res(sid, items)
        fs.append(status.Feed(BY_ID[sid], r, r))
    return status.compute(fs, loc, NOW)


# --- SWPC ---
def test_swpc_quiet_is_green(loc):
    items = noaa.parse_swpc(fixture("swpc_quiet.json"))
    assert [i["g_scale"] for i in items] == [0, 0]
    assert compute(loc, {"noaa_swpc": items})["color"] == "green"


def test_swpc_observed_g4_amber_and_forecast_g5_labeled(loc):
    items = noaa.parse_swpc(fixture("swpc_storm.json"))
    now, fc = items
    assert now["kind"] == "spaceweather" and now["g_scale"] == 4
    assert fc["kind"] == "forecast" and fc["g_scale"] == 5
    b = compute(loc, {"noaa_swpc": items})
    assert b["color"] == "amber"
    assert any(a.startswith("Forecast, not an event: Geomagnetic") for a in b["triggers"]["amber"])
    g5 = dict(now, g_scale=5)
    assert compute(loc, {"noaa_swpc": [g5]})["color"] == "red"


# --- SPC ---
def test_point_in_polygon():
    sq = {"type": "Polygon", "coordinates": [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]}
    assert noaa.point_in_geometry(0, 0, sq) and not noaa.point_in_geometry(2, 0, sq)


def test_spc_picks_highest_category_covering_location(loc):
    items = noaa.parse_spc(1, fixture("spc_day1_mdt.json"), fixture("spc_day1_torn.json"), loc)
    assert len(items) == 1
    it = items[0]
    assert it["spc_category"] == "MDT" and it["tornado_pct"] == 10        # HIGH polygon is far away
    b = compute(loc, {"noaa_spc": items})
    assert b["color"] == "amber" and b["rule"].startswith("Forecast, not an event: Day 1")


def test_spc_day2_moderate_does_not_color(loc):
    items = noaa.parse_spc(2, fixture("spc_day1_mdt.json"), None, loc)
    assert compute(loc, {"noaa_spc": items})["color"] == "green"


def test_spc_outside_all_polygons_returns_nothing(loc):
    far = {"type": "FeatureCollection", "features": [f for f in fixture("spc_day1_mdt.json")["features"]
                                                      if f["properties"]["DN"] == 8]}
    assert noaa.parse_spc(1, far, None, loc) == []


# --- CISA ---
def test_cisa_keeps_recent_infrastructure_only(loc):
    items = gov_extra.parse_cisa((FIX / "cisa.xml").read_text(), NOW)
    assert [i["title"] for i in items] == ["SYNTHETIC State-Sponsored Actors Target Electric Utilities"]
    assert compute(loc, {"cisa": items})["color"] == "green"               # shown only


# --- NRC ---
def test_nrc_filters_nearby_plants_and_reads_emergency_class(loc):
    hits = gov_extra.parse_nrc_feed((FIX / "nrc_feed.xml").read_text())
    assert [h[1] for h in hits] == ["Perry"]
    assert gov_extra.emergency_class((FIX / "nrc_report.html").read_text(), "99001") == "Alert"


def test_nrc_fetch_and_banner(loc):
    base = mock_transport().handle_request

    def handler(req):
        if req.url.path == "/public-involve/rss":
            return httpx.Response(200, text=(FIX / "nrc_feed.xml").read_text())
        if req.url.path.endswith("/event-notification-reports/en"):
            return httpx.Response(200, text=(FIX / "nrc_report.html").read_text())
        return base(req)

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await gov_extra.fetch_nrc(c, loc)
    r = asyncio.run(go())
    assert r["ok"] and r["items"][0]["emergency_class"] == "Alert"
    assert compute(loc, {"nrc": r["items"]})["color"] == "amber"
    sae = dict(r["items"][0], emergency_class="Site Area Emergency")
    assert compute(loc, {"nrc": [sae]})["color"] == "red"


# --- AirNow ---
def test_airnow_categories(loc):
    items = gov_extra.parse_airnow(fixture("airnow_bad.json"), "44224")
    assert {i["aqi_category"] for i in items} == {5, 1}
    assert compute(loc, {"airnow": items})["color"] == "amber"
    haz = dict(items[0], aqi_category=6)
    assert compute(loc, {"airnow": [haz]})["color"] == "red"


def test_airnow_key_never_leaks(loc, monkeypatch):
    monkeypatch.setenv("AIRNOW_API_KEY", "SECRET-AIR-KEY")
    t = mock_transport(fail=["/aq/"])

    async def go():
        async with httpx.AsyncClient(transport=t) as c:
            return await gov_extra.fetch_airnow(c, loc)
    r = asyncio.run(go())
    assert t.seen[0].url.params["API_KEY"] == "SECRET-AIR-KEY"
    assert r["ok"] is False and "SECRET" not in str(r)


def test_airnow_missing_key(loc, monkeypatch):
    monkeypatch.delenv("AIRNOW_API_KEY", raising=False)

    async def go():
        async with httpx.AsyncClient(transport=mock_transport()) as c:
            return await gov_extra.fetch_airnow(c, loc)
    assert "AIRNOW_API_KEY" in asyncio.run(go())["error"]
