from app import status
from app.adapters import dhs, fema, usgs
from app.sources import BY_ID
from tests.conftest import FIX, NOW, fixture
from tests.test_status import feeds, res


def compute(loc, extra):
    fs = feeds()
    for sid, items in extra.items():
        r = res(sid, items)
        fs.append(status.Feed(BY_ID[sid], r, r))
    return status.compute(fs, loc, NOW)


def test_ntas_empty_feed_means_no_advisories():
    assert dhs.parse((FIX / "dhs_ntas_empty.xml").read_text()) == []


def test_ntas_parses_attributes_and_children_and_guards_links():
    items = dhs.parse((FIX / "dhs_ntas_alerts.xml").read_text())
    assert [i["ntas_type"] for i in items] == ["Bulletin", "Elevated Threat Alert"]
    assert items[0]["starts"].startswith("2030-01-09T11:00") and items[0]["ends"].startswith("2030-04-09T23:59")
    assert items[1]["starts"].startswith("2030-01-10T08:00")                 # child-element form
    assert items[1]["url"] == dhs.HOME                                         # off-site link replaced
    assert all(i["kind"] == "alert" and i["origin"] == "ntas" for i in items)


def test_ntas_bulletin_shown_only_elevated_amber_imminent_red(loc):
    items = dhs.parse((FIX / "dhs_ntas_alerts.xml").read_text())
    bulletin, elevated = items
    assert compute(loc, {"dhs_ntas": [bulletin]})["color"] == "green"
    b = compute(loc, {"dhs_ntas": [elevated]})
    assert b["color"] == "amber" and "NTAS Elevated Threat Alert" in b["rule"]
    imminent = dict(elevated, ntas_type="Imminent Threat Alert", event="NTAS Imminent Threat Alert")
    assert compute(loc, {"dhs_ntas": [imminent]})["color"] == "red"


def test_usgs_parse_distance_recency_and_pager(loc):
    items = usgs.parse(fixture("usgs_quakes.json"), loc, NOW)
    near = next(i for i in items if i["magnitude"] == 4.8)
    assert near["recent_24h"] and near["distance_km"] < 20 and near["severity"] is None
    big = next(i for i in items if i["magnitude"] == 5.9)
    assert big["pager"] == "orange" and big["severity"] == "PAGER orange"
    assert items[0]["starts"] > items[-1]["starts"]                            # newest first


def test_usgs_banner_rules(loc):
    items = usgs.parse(fixture("usgs_quakes.json"), loc, NOW)
    by_mag = {i["magnitude"]: i for i in items}
    assert compute(loc, {"usgs_quakes": [by_mag[3.1]]})["color"] == "green"   # small and far: shown only
    a = compute(loc, {"usgs_quakes": [by_mag[4.8]]})
    assert a["color"] == "amber" and "in the last 24 hours" in a["rule"]
    assert compute(loc, {"usgs_quakes": [by_mag[5.9]]})["color"] == "red"     # USGS PAGER orange


def test_ipaws_matches_national_same_code(loc):
    rec = {"originalMessage": "<geocode><valueName>SAME</valueName><value>000000</value></geocode>", "info": []}
    assert fema._matches_county(rec, loc)
    other = {"originalMessage": "<value>006037</value>", "info": []}
    assert not fema._matches_county(other, loc)
