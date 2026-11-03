from app import status
from app.adapters import pjm
from app.sources import BY_ID
from tests.conftest import FIX, NOW
from tests.test_status import feeds, res


def items():
    return pjm.parse((FIX / "pjm_insidelines.xml").read_text(), NOW)


def test_parse_flags_recent_operations_update_only():
    got = {i["title"].split(" (")[0]: (i["ops_action"], i["recent"]) for i in items()}
    assert got["Operations Update: PJM Issues Cold Weather Alert for Jan. 11"] == (True, True)
    assert got["Operations Update: PJM Issues Hot Weather Alert"] == (True, False)   # older than 48h
    assert got["PJM Explains Winter Preparations"] == (False, True)                  # not an ops action
    assert got["PJM Issues Maximum Generation Alert for Jan. 11"] == (True, True)    # no prefix needed
    assert got["PJM Reviews December Cold Weather Alert Operations"] == (False, True)  # retrospective
    assert all(i["url"].startswith("https://insidelines.pjm.com/") for i in items())  # off-site dropped
    assert all(i["kind"] == "notice" and i["severity"] is None for i in items())


def test_recent_ops_update_is_amber_with_rule(loc):
    b = run_with(items(), loc)
    assert b["color"] == "amber" and b["rule"].startswith("PJM operations notice: ")
    assert len([a for a in b["triggers"]["amber"] if "PJM operations notice" in a]) == 2


def test_no_ops_update_stays_green(loc):
    b = run_with([i for i in items() if not i["ops_action"]], loc)
    assert b["color"] == "green"


def run_with(pjm_items, loc):
    fs = feeds()
    r = res("pjm_insidelines", pjm_items)
    fs.append(status.Feed(BY_ID["pjm_insidelines"], r, r))
    return status.compute(fs, loc, NOW)
