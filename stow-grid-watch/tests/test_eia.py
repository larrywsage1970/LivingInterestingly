import asyncio

import httpx

from app.adapters import eia
from tests.conftest import NOW, fixture, mock_transport


def test_parse_latest_demand_vs_7day_peak_and_forecast():
    items = eia.parse(fixture("eia_pjm.json"), NOW)
    obs, fc = items
    assert obs["kind"] == "observation" and obs["severity"] is None
    assert obs["starts"].startswith("2030-01-10T15")          # null value at 16Z skipped
    assert obs["value_mw"] == 95000 and obs["peak_7d_mw"] == 120000 and obs["pct_of_peak"] == 79
    assert fc["kind"] == "forecast" and fc["value_mw"] == 108000
    assert all(i["url"].startswith("https://www.eia.gov/") for i in items)


def test_parse_empty_raises():
    try:
        eia.parse({"response": {"data": []}}, NOW)
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_missing_key_is_reported_not_crashed(loc, monkeypatch):
    monkeypatch.delenv("EIA_API_KEY", raising=False)

    async def go():
        async with httpx.AsyncClient(transport=mock_transport()) as c:
            return await eia.fetch(c, loc)
    res = asyncio.run(go())
    assert res["ok"] is False and "EIA_API_KEY" in res["error"]


def test_key_sent_but_never_leaked_in_errors(loc, monkeypatch):
    monkeypatch.setenv("EIA_API_KEY", "SECRET-TEST-KEY")
    t = mock_transport(fail=["/region-data/"])

    async def go():
        async with httpx.AsyncClient(transport=t) as c:
            return await eia.fetch(c, loc)
    res = asyncio.run(go())
    assert t.seen[0].url.params["api_key"] == "SECRET-TEST-KEY"
    assert res["ok"] is False and "SECRET" not in str(res)


def test_fetch_ok_items_contain_no_key(loc, monkeypatch):
    monkeypatch.setenv("EIA_API_KEY", "SECRET-TEST-KEY")

    async def go():
        async with httpx.AsyncClient(transport=mock_transport()) as c:
            return await eia.fetch(c, loc)
    res = asyncio.run(go())
    assert res["ok"] and "SECRET" not in str(res)
