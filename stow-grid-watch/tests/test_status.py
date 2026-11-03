from datetime import timedelta

from app import status
from app.adapters import fema, nws
from app.adapters.base import item
from app.sources import BY_ID
from tests.conftest import NOW, fixture

MILD = [item("forecast", "Tonight: Low 30°F", "https://x", period="Tonight", is_low=True, temperature=30)]


def res(source, items, *, age_s=0, ok=True):
    r = {"source": source, "label": BY_ID[source].label, "ok": ok, "items": items if ok else [],
         "fetched_at": (NOW - timedelta(seconds=age_s)).isoformat()}
    if not ok:
        r["error"] = "HTTPStatusError: 503"
    return r


def feeds(alerts=(), forecast=MILD, ipaws=(), decls=(), overrides=None):
    data = {"nws_alerts": res("nws_alerts", list(alerts)),
            "nws_forecast": res("nws_forecast", list(forecast)),
            "fema_ipaws": res("fema_ipaws", list(ipaws)),
            "fema_declarations": res("fema_declarations", list(decls))}
    out = []
    for sid, r in data.items():
        latest, good = (overrides or {}).get(sid, (r, r))
        out.append(status.Feed(BY_ID[sid], latest, good))
    return out


def run(loc, **kw):
    return status.compute(feeds(**kw), loc, NOW)


# ---- acceptance: fixture -> color ----

def test_warning_fixture_is_red(loc):
    b = run(loc, alerts=nws.parse_alerts(fixture("nws_alerts_warning.json")))
    assert b["color"] == "red" and "Winter Storm Warning" in b["rule"]


def test_advisory_fixture_is_amber(loc):
    b = run(loc, alerts=nws.parse_alerts(fixture("nws_alerts_advisory.json")))
    assert b["color"] == "amber" and "Winter Weather Advisory" in b["rule"]


def test_empty_fixture_is_green(loc):
    b = run(loc, alerts=nws.parse_alerts(fixture("nws_alerts_empty.json")))
    assert b["color"] == "green"


# ---- gray / staleness ----

def test_required_feed_stale_beyond_2x_cadence_is_gray(loc):
    old = res("nws_alerts", [], age_s=2 * 300 + 1)
    b = run(loc, overrides={"nws_alerts": (old, old)})
    assert b["color"] == "gray" and "NWS alerts is stale" in b["rule"]


def test_required_feed_at_exactly_2x_cadence_is_still_fresh(loc):
    edge = res("nws_alerts", [], age_s=600)
    assert run(loc, overrides={"nws_alerts": (edge, edge)})["color"] == "green"


def test_required_feed_failing_is_gray_with_last_good_time(loc):
    good = res("nws_alerts", [], age_s=120)
    bad = res("nws_alerts", [], ok=False)
    b = run(loc, overrides={"nws_alerts": (bad, good)})
    assert b["color"] == "gray" and "unavailable" not in b["rule"] and "failing" in b["rule"]
    assert "last good" in b["rule"]


def test_never_fetched_is_gray(loc):
    b = run(loc, overrides={"nws_forecast": (None, None)})
    assert b["color"] == "gray" and "no good data yet" in b["rule"]


def test_gray_beats_amber(loc):
    old = res("nws_forecast", MILD, age_s=99999)
    b = run(loc, alerts=nws.parse_alerts(fixture("nws_alerts_advisory.json")),
            overrides={"nws_forecast": (old, old)})
    assert b["color"] == "gray"


def test_known_red_beats_gray(loc):
    b = run(loc, alerts=nws.parse_alerts(fixture("nws_alerts_warning.json")),
            overrides={"nws_forecast": (None, None)})
    assert b["color"] == "red"


def test_optional_feed_failing_does_not_gray(loc):
    bad = res("fema_ipaws", [], ok=False)
    b = run(loc, overrides={"fema_ipaws": (bad, None)})
    assert b["color"] == "green"
    fs = next(f for f in b["feeds"] if f["id"] == "fema_ipaws")
    assert fs["state"] == "failing"


# ---- other amber/red rules ----

def test_forecast_low_below_threshold_is_amber_and_labeled_forecast(loc):
    fc = nws.parse_forecast(fixture("nws_forecast.json"), "https://x/forecast", NOW)
    b = run(loc, forecast=fc)
    assert b["color"] == "amber" and b["rule"].startswith("Forecast, not an event")


def test_ipaws_shelter_in_place_is_red_boil_water_is_amber(loc):
    ip = fema.parse_ipaws(fixture("fema_ipaws.json"), NOW)
    b = run(loc, ipaws=ip)
    assert b["color"] == "red" and "Shelter In Place Warning" in b["rule"]
    assert any("Boil Water Notice" in a for a in b["triggers"]["amber"])


def test_active_fema_declaration_is_amber_closed_is_ignored(loc):
    d = fema.parse_declarations(fixture("fema_declarations.json"), NOW)
    b = run(loc, decls=d)
    assert b["color"] == "amber" and "9901" in b["rule"]
    assert len(b["triggers"]["amber"]) == 1


def test_expired_alert_is_ignored(loc):
    a = nws.parse_alerts(fixture("nws_alerts_warning.json"))
    a[0]["ends"] = (NOW - timedelta(minutes=1)).isoformat()
    assert run(loc, alerts=a)["color"] == "green"
