import asyncio

import httpx

from app.adapters import ohgo
from tests.conftest import NOW, fixture
from tests.test_more_gov import compute

F = fixture("ohgo.json")


def test_incidents_and_slowdowns_are_notable():
    inc = ohgo.parse_incidents(F["incidents"])
    assert inc[0]["kind"] == "road" and inc[0]["notable"] and inc[0]["road_type"] == "incident"
    assert inc[0]["title"].startswith("Crash: Ramp from I-77 N")
    slow = ohgo.parse_slowdowns(F["slowdowns"])
    assert slow[0]["notable"] and "about 3 mph (normally 58 mph)" in slow[0]["raw_excerpt"]


def test_construction_in_effect_deduped_and_new_closures_notable(loc):
    items = ohgo.parse_construction(F["construction"], NOW, loc.tz)
    titles = [i["title"] for i in items]
    # open, already-ended and future work zones dropped; two directions of SR 176 merged
    assert titles == ["Road closed: State Route 176 culvert replacement, Richfield",
                      "Road closed: Perkins ramp to SR 8 north",
                      "Lane restrictions: I-77 in the City of Akron"]
    assert [i["notable"] for i in items] == [True, False, False]   # only the closure that began in the last 3 days
    assert items[0]["starts"].startswith("2030-01-09T05:00")          # local Eastern time converted to UTC


def test_roads_never_change_the_banner(loc):
    items = ohgo.parse_incidents([dict(F["incidents"][0], roadStatus="Closed")]) + \
        ohgo.parse_construction(F["construction"], NOW, loc.tz)
    assert compute(loc, {"ohgo": items})["color"] == "green"


def test_fetch_without_key_reports_error(loc, monkeypatch):
    monkeypatch.delenv("OHGO_API_KEY", raising=False)
    monkeypatch.delenv("OHGO_API_KE", raising=False)
    r = asyncio.run(ohgo.fetch(httpx.AsyncClient(), loc))
    assert not r["ok"] and "OHGO_API_KEY" in r["error"]


def test_fetch_sends_key_header_and_radius(loc, monkeypatch):
    monkeypatch.setenv("OHGO_API_KEY", "k123")
    seen = []

    def handler(req):
        seen.append(req)
        name = req.url.path.rsplit("/", 1)[-1]
        data = {"incidents": F["incidents"], "dangerous-slowdowns": F["slowdowns"], "construction": []}[name]
        return httpx.Response(200, json={"results": data})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await ohgo.fetch(c, loc)

    r = asyncio.run(go())
    assert r["ok"] and len(r["items"]) == 2
    assert all(q.headers["Authorization"] == "APIKEY k123" for q in seen)
    assert seen[0].url.params["radius"].endswith(",10")
