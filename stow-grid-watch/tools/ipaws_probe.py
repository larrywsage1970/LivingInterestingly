"""Temporary probe: learn which OpenFEMA IPAWS queries work. Prints shapes and counts, not content."""
import json
from datetime import datetime, timedelta, timezone

import httpx

URL = "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts"
UA = {"User-Agent": "StowGridWatch/0.1 (contact: larrywsage@gmail.com)"}
since = (datetime.now(timezone.utc) - timedelta(hours=72)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
LON, LAT = -81.4404, 41.1595

variants = {
    "plain_top2": {"$top": "2"},
    "sent_ge": {"$filter": f"sent ge '{since}'", "$top": "1", "$count": "true"},
    "geo_nospace": {"$filter": f"geo.intersects(searchGeometry, geography'POINT({LON} {LAT})')", "$top": "1"},
    "geo_srid": {"$filter": f"geo.intersects(searchGeometry, geography'SRID=4326;POINT({LON} {LAT})')", "$top": "1"},
    "geo_only_space": {"$filter": f"geo.intersects(searchGeometry, geography 'POINT({LON} {LAT})')", "$top": "1"},
    "sender_ne_nws": {"$filter": f"sent ge '{since}' and sender ne 'w-nws.webmaster@noaa.gov'", "$top": "1", "$count": "true"},
    "contains_summit": {"$filter": f"sent ge '{since}' and contains(originalMessage,'039153')", "$top": "3", "$count": "true"},
}


def shape(v, depth=0):
    if isinstance(v, dict):
        return {k: shape(x, depth + 1) for k, x in v.items()} if depth < 4 else "{...}"
    if isinstance(v, list):
        return [shape(v[0], depth + 1)] if v else []
    return type(v).__name__


with httpx.Client(timeout=30, headers=UA) as c:
    for name, params in variants.items():
        try:
            r = c.get(URL, params=params)
            print(f"\n=== {name}: HTTP {r.status_code}")
            if r.status_code != 200:
                print(r.text[:400])
                continue
            d = r.json()
            print("metadata:", json.dumps(d.get("metadata"))[:300])
            recs = d.get("IpawsArchivedAlerts", [])
            print("records:", len(recs))
            if recs and name == "plain_top2":
                print("record shape:", json.dumps(shape(recs[0]))[:2500])
                info = (recs[0].get("info") or [{}])[0]
                for a in info.get("area", []) or []:
                    print("geocode valueNames:", [g.get("valueName") for g in a.get("geocode", []) or []][:5])
            for rec in recs[:3]:
                info = (rec.get("info") or [{}])[0]
                print(" -", rec.get("sender"), "|", rec.get("sent"), "|", info.get("event"))
        except Exception as e:  # noqa: BLE001
            print(f"\n=== {name}: {type(e).__name__}: {e}")
