"""Temporary probe: learn which OpenFEMA IPAWS queries work. Prints shapes and counts, not content."""
import json
from datetime import datetime, timedelta, timezone

import httpx

URL = "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts"
UA = {"User-Agent": "StowGridWatch/0.1 (contact: larrywsage@gmail.com)"}
since = (datetime.now(timezone.utc) - timedelta(hours=72)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
LON, LAT = -81.4404, 41.1595

since30 = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
GEO = f"geo.intersects(searchGeometry, geography'POINT({LON} {LAT})')"
variants = {
    "final_72h": {"$filter": f"sent ge '{since}' and {GEO}", "$orderby": "sent desc", "$top": "50"},
    "final_72h_no_nws": {"$filter": f"sent ge '{since}' and sender ne 'w-nws.webmaster@noaa.gov' and {GEO}",
                         "$orderby": "sent desc", "$top": "50"},
    "sample_30d_no_nws": {"$filter": f"sent ge '{since30}' and sender ne 'w-nws.webmaster@noaa.gov' and {GEO}",
                          "$orderby": "sent desc", "$top": "5"},
    "sample_30d_any": {"$filter": f"sent ge '{since30}' and {GEO}", "$orderby": "sent desc", "$top": "2"},
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
            if recs and name.startswith("sample"):
                print("record shape:", json.dumps(shape(recs[0]))[:2500])
                info = (recs[0].get("info") or [{}])[0]
                print("areas[0] shape:", json.dumps(shape((info.get("areas") or [{}])[0]))[:800])
                print("status/msgType:", recs[0].get("status"), recs[0].get("msgType"), "| info langs:",
                      [i.get("language") for i in recs[0].get("info") or []])
            for rec in recs[:3]:
                info = (rec.get("info") or [{}])[0]
                print(" -", rec.get("sender"), "|", rec.get("sent"), "|", info.get("event"))
        except Exception as e:  # noqa: BLE001
            print(f"\n=== {name}: {type(e).__name__}: {e}")
