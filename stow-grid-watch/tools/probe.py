"""Temporary probe: shapes of SWPC, SPC, CISA, CDC HAN, NRC feeds (no content beyond titles)."""
import json, re
import httpx

UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}
URLS = [
    "https://services.swpc.noaa.gov/products/noaa-scales.json",
    "https://services.swpc.noaa.gov/products/alerts.json",
    "https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson",
    "https://www.spc.noaa.gov/products/outlook/day1otlk_torn.lyr.geojson",
    "https://www.spc.noaa.gov/products/outlook/day2otlk_cat.lyr.geojson",
    "https://www.cisa.gov/cybersecurity-advisories/all.xml",
    "https://www.cisa.gov/cybersecurity-advisories/ics-advisories.xml",
    "https://www.cisa.gov/cybersecurity-advisories/alerts.xml",
    "https://www.cisa.gov/cybersecurity-advisories/cybersecurity-advisories.xml",
    "https://www.cisa.gov/robots.txt",
    "https://emergency.cdc.gov/han/index.asp",
    "https://tools.cdc.gov/api/v2/resources/media/413690.rss",
    "https://www.cdc.gov/han/php/notices/index.html",
    "https://www.nrc.gov/reading-rm/doc-collections/event-status/event/",
    "https://www.nrc.gov/public-involve/rss?feed=event",
    "https://www.nrc.gov/reading-rm/doc-collections/event-status/rss.xml",
    "https://www.airnowapi.org/aq/observation/zipCode/current/?format=application/json&zipCode=44224&distance=25",
]


def text(h):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>|<style.*?</style>", " ", h, flags=re.S)))


with httpx.Client(timeout=25, headers=UA, follow_redirects=True) as c:
    for u in URLS:
        try:
            r = c.get(u)
        except Exception as e:  # noqa: BLE001
            print(f"\n=== {u}\n ERR {type(e).__name__}: {str(e)[:150]}"); continue
        ct = r.headers.get("content-type", ""); t = r.text
        print(f"\n=== {u}\n HTTP {r.status_code} | {ct} | {len(r.content)}b | final {r.url}")
        if "robots" in u:
            print(" " + " | ".join([l for l in t.splitlines() if l.strip() and not l.startswith("#")][:30])); continue
        if r.status_code != 200:
            print(" ", t[:200].replace("\n", " ")); continue
        if "json" in ct or t.lstrip()[:1] in "[{":
            try:
                d = r.json()
            except Exception:
                print(" not json:", t[:200]); continue
            if isinstance(d, dict) and "features" in d:
                fs = d["features"]; print(" features:", len(fs))
                for f in fs[:8]:
                    p = f.get("properties", {}); g = f.get("geometry") or {}
                    print("  -", {k: p[k] for k in list(p)[:8]}, "| geom:", g.get("type"))
            elif isinstance(d, dict):
                print(" keys:", list(d)[:8]); print(" ", json.dumps(d)[:700])
            else:
                print(" list len:", len(d))
                for x in d[:3]:
                    print("  -", json.dumps(x)[:400])
            continue
        if "xml" in ct or "rss" in ct or t.lstrip().startswith("<?xml"):
            titles = re.findall(r"<item>.*?<title>(.*?)</title>.*?(?:<pubDate>(.*?)</pubDate>)?", t, re.S)[:8]
            print(" items:", len(re.findall(r"<item>", t)), "| first:", titles)
            cats = sorted(set(re.findall(r"<category[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</category>", t)))[:25]
            print(" categories:", cats); continue
        links = sorted({l for l in re.findall(r'href=["\']([^"\']+)["\']', t) if re.search(r"rss|xml|feed|json|han|event|\.txt", l, re.I)})[:25]
        print(" links:", links)
        tt = text(t)
        for kw in ["RSS", "HAN", "Health Advisory", "Event Notification", "Emergency Class", "Perry", "Beaver Valley"]:
            m = re.search(re.escape(kw), tt)
            if m: print(f"  [{kw}] ...{tt[max(0,m.start()-120):m.end()+180]}...")
