"""Temporary probe: FirstEnergy outage pages, any sanctioned data feed, robots and terms."""
import re
import httpx

UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}
URLS = [
    "https://www.firstenergycorp.com/robots.txt",
    "https://www.firstenergycorp.com/outages_help.html",
    "https://www.firstenergycorp.com/outages_help/current_outages_maps.html",
    "https://www.firstenergycorp.com/content/customer/outages_help.html",
    "https://outages.firstenergycorp.com/",
    "https://outages.firstenergycorp.com/robots.txt",
    "https://www.firstenergycorp.com/help/terms-of-use.html",
    "https://www.firstenergycorp.com/terms_of_use.html",
]
LINK = re.compile(r'''href=["']([^"']+)["']''', re.I)
KW = ["outage map", "rss", "api", "data feed", "storm center", "kubra", "terms of use", "automated",
      "scrap", "robot", "crawl", "Ohio Edison", "text OUT", "alerts", "notification"]


def text(html: str) -> str:
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t))


with httpx.Client(timeout=25, headers=UA, follow_redirects=True) as c:
    for u in URLS:
        try:
            r = c.get(u)
        except Exception as e:  # noqa: BLE001
            print(f"\n=== {u}\n  ERR {type(e).__name__}: {str(e)[:200]}"); continue
        ct = r.headers.get("content-type", "")
        print(f"\n=== {u}\n  HTTP {r.status_code} | {ct} | {len(r.content)}b | final {r.url}")
        if u.endswith("robots.txt"):
            if r.status_code == 200:
                print("  " + "\n  ".join([l for l in r.text.splitlines() if l.strip()][:40]))
            continue
        if r.status_code != 200 or "html" not in ct:
            continue
        links = sorted({l for l in LINK.findall(r.text) if re.search(r"outage|storm|map|kubra|rss|api|feed|terms|alert", l, re.I)})
        print(f"  relevant links ({len(links)}):"); [print("   ", l) for l in links[:30]]
        scripts = sorted(set(re.findall(r'(?:src|data-[a-z-]+)=["\']([^"\']*(?:kubra|stormcenter|outage)[^"\']*)["\']', r.text, re.I)))[:10]
        if scripts: print("  scripts/data refs:", scripts)
        t = text(r.text)
        for kw in KW:
            for m in list(re.finditer(re.escape(kw), t, re.I))[:2]:
                print(f"  [{kw}] ...{t[max(0, m.start()-160):m.end()+200]}...")
