"""Temporary probe: what machine-readable PJM emergency/ops feeds exist, and what do robots/terms allow."""
import re
import httpx

UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}
URLS = [
    "https://www.pjm.com/robots.txt",
    "https://www.pjm.com/markets-and-operations/etools/emerg-procedure.aspx",
    "https://emergencyprocedures.pjm.com/robots.txt",
    "https://emergencyprocedures.pjm.com/ep/pages/dashboard.jsf",
    "https://emergencyprocedures.pjm.com/",
    "https://insidelines.pjm.com/robots.txt",
    "https://insidelines.pjm.com/feed/",
    "https://insidelines.pjm.com/category/operations/feed/",
    "https://api.pjm.com/api/v1/",
    "https://dataminer2.pjm.com/feed/list",
    "https://www.pjm.com/-/media/etc/rss.ashx",
]
LINK = re.compile(r'''(?:href|src)=["']([^"']*(?:rss|feed|xml|json|api|export|download|\.csv)[^"']*)["']''', re.I)

with httpx.Client(timeout=25, headers=UA, follow_redirects=True) as c:
    for u in URLS:
        try:
            r = c.get(u)
        except Exception as e:  # noqa: BLE001
            print(f"\n=== {u}\n  ERR {type(e).__name__}: {e}"); continue
        ct = r.headers.get("content-type", "")
        print(f"\n=== {u}\n  HTTP {r.status_code} | {ct} | {len(r.content)} bytes | final {r.url}")
        body = r.text
        if "robots.txt" in u and r.status_code == 200:
            print("  " + "\n  ".join(l for l in body.splitlines() if l.strip())[:1500])
            continue
        if "xml" in ct or "rss" in ct or body.lstrip().startswith("<?xml"):
            items = re.findall(r"<item>.*?<title>(.*?)</title>.*?<pubDate>(.*?)</pubDate>", body, re.S)
            print(f"  feed items: {len(items)}; first: {items[:3]}")
            cats = sorted(set(re.findall(r"<category><!\[CDATA\[(.*?)\]\]></category>", body)))[:20]
            print(f"  categories: {cats}")
            continue
        if "json" in ct:
            print("  json head:", body[:300]); continue
        links = sorted(set(LINK.findall(body)))[:40]
        print(f"  candidate links ({len(links)}):"); [print("   ", l) for l in links]
        for kw in ["Terms", "terms of use", "Hot Weather Alert", "Cold Weather Alert", "Maximum Generation", "Load Management", "No active"]:
            if kw.lower() in body.lower():
                print(f"  mentions: {kw}")
