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
since7 = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
variants = {
    "recent_geom_null": {"$filter": f"sent ge '{since7}' and searchGeometry eq null", "$top": "1", "$inlinecount": "allpages"},
    "recent_geom_notnull": {"$filter": f"sent ge '{since7}' and searchGeometry ne null", "$top": "1", "$inlinecount": "allpages"},
    "recent_any": {"$filter": f"sent ge '{since7}'", "$top": "1", "$inlinecount": "allpages"},
    "same_summit_30d": {"$filter": f"sent ge '{since30}' and contains(originalMessage,'039153')", "$top": "5", "$orderby": "sent desc"},
    "text_summit_oh_30d": {"$filter": f"sent ge '{since30}' and contains(originalMessage,'Summit') and contains(originalMessage,'OH')", "$top": "5", "$orderby": "sent desc"},
    "nws_ohio_7d": {"$filter": f"sent ge '{since7}' and sender eq 'w-nws.webmaster@noaa.gov' and contains(originalMessage,'Ohio')", "$top": "3", "$orderby": "sent desc", "$inlinecount": "allpages"},
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
            print("records:", len(recs), "| count:", d.get("metadata", {}).get("count"))
            for rec in recs[:5]:
                print("   searchGeometry is", "null" if rec.get("searchGeometry") is None else "set")
            if recs and name in ("same_summit_30d", "recent_geom_null"):
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


# Cross-check: NWS's own archive of alerts for the point over the last 7 days.
with httpx.Client(timeout=30, headers={**UA, "Accept": "application/geo+json"}) as c:
    r = c.get("https://api.weather.gov/alerts", params={"point": f"{LAT},{LON}", "start": since7.replace(".000Z", "Z")})
    print("\n=== NWS alerts for point, last 7d: HTTP", r.status_code)
    if r.status_code == 200:
        feats = r.json().get("features", [])
        print("count:", len(feats))
        for f in feats[:5]:
            pr = f["properties"]
            print(" -", pr.get("sent"), "|", pr.get("event"), "|", pr.get("status"))
    else:
        print(r.text[:300])
