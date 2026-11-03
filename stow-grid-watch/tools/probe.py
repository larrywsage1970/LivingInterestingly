"""Temporary probe: DHS NTAS feed and USGS earthquake feed (shape only)."""
import json, re
import httpx

UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}
URLS = [
    "https://www.dhs.gov/ntas/1.1/feeds.xml",
    "https://www.dhs.gov/ntas/1.1/alerts.xml",
    "https://www.dhs.gov/ntas/1.0/alerts.xml",
    "https://www.dhs.gov/ntas/",
    "https://www.dhs.gov/national-terrorism-advisory-system",
    "https://www.dhs.gov/robots.txt",
    "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=41.1595&longitude=-81.4404&maxradiuskm=300&minmagnitude=2.5&starttime=2026-09-01&orderby=time&limit=5",
]
with httpx.Client(timeout=25, headers=UA, follow_redirects=True) as c:
    for u in URLS:
        try:
            r = c.get(u)
        except Exception as e:  # noqa: BLE001
            print(f"\n=== {u}\n ERR {type(e).__name__}: {str(e)[:150]}"); continue
        ct = r.headers.get("content-type", "")
        print(f"\n=== {u}\n HTTP {r.status_code} | {ct} | {len(r.content)}b | final {r.url}")
        t = r.text
        if "robots" in u:
            print(" " + " | ".join([l for l in t.splitlines() if l.strip()][:25])); continue
        if "json" in ct:
            d = r.json(); print(" keys:", list(d)[:6], "| metadata:", json.dumps(d.get("metadata"))[:300])
            for f in d.get("features", [])[:3]:
                p = f["properties"]; print("  -", p.get("mag"), p.get("place"), p.get("time"), p.get("url"), "| keys:", sorted(p)[:12])
            continue
        if "xml" in ct or t.lstrip().startswith("<?xml"):
            print(" head:", re.sub(r"\s+", " ", t[:1500])); continue
        links = sorted({l for l in re.findall(r'href=["\']([^"\']+)["\']', t) if re.search(r"ntas|xml|feed|rss|json|widget", l, re.I)})[:20]
        print(" links:", links)
        tt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>", " ", t, flags=re.S)))
        for kw in ["There are no current", "Bulletin", "Elevated", "Imminent", "expires", "XML", "feed"]:
            m = re.search(re.escape(kw), tt, re.I)
            if m: print(f"  [{kw}] ...{tt[max(0,m.start()-150):m.end()+200]}...")
