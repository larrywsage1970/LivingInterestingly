"""Temporary probe: CDC HAN via CDC's syndication API / page; CDC outbreak RSS; AirNow 410 body (key redacted)."""
import json, os, re
import httpx

UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}
KEY = os.environ.get("AIRNOW_API_KEY", "")


def red(s):
    return s.replace(KEY, "***") if KEY else s


with httpx.Client(timeout=30, headers=UA, follow_redirects=True) as c:
    for u in ["https://www.cdc.gov/robots.txt"]:
        r = c.get(u); print("=== robots", r.status_code, " | ".join(l for l in r.text.splitlines() if l.startswith(("Disallow", "User-agent")))[:600])
    for u in ["https://tools.cdc.gov/api/v2/resources/media?q=health%20alert%20network&max=5&sort=-dateModified",
              "https://tools.cdc.gov/api/v2/resources/media?topic=Health%20Alert%20Network&max=5",
              "https://tools.cdc.gov/api/v2/resources/media?name=HAN&max=5&sort=-datePublished"]:
        r = c.get(u)
        print("=== syndication", u, r.status_code, r.headers.get("content-type"))
        try:
            d = r.json(); res = d.get("results") or []
            print("   total:", (d.get("meta") or {}).get("pagination", {}).get("total"), "| results:", [(x.get("name"), x.get("datePublished"), x.get("sourceUrl")) for x in res[:5]])
        except Exception as e:  # noqa: BLE001
            print("   not json", r.text[:200])
    r = c.get("https://www.cdc.gov/han/php/notices/index.html")
    t = r.text
    print("=== HAN notices page", r.status_code, len(t))
    hrefs = re.findall(r'href="([^"]*han\d{5}[^"]*)"', t)
    print("   han links:", hrefs[:8], "| count", len(set(hrefs)))
    for m in list(re.finditer(r"(HAN|Health Advisory|Health Update|Health Alert)[^<]{0,160}", t))[:8]:
        print("   txt:", re.sub(r"\s+", " ", m.group(0))[:160])
    if not hrefs:
        print("   script srcs:", re.findall(r'<script[^>]+src="([^"]+)"', t)[:10])
        print("   data/json refs:", sorted(set(re.findall(r'["\']([^"\']+\.json[^"\']*)["\']', t)))[:10])
    r = c.get("https://tools.cdc.gov/api/v2/resources/media/285676.rss")
    items = re.findall(r"<item>.*?<title>(.*?)</title>.*?<pubDate>(.*?)</pubDate>", r.text, re.S)[:5]
    print("=== CDC outbreaks RSS", r.status_code, items)
    if KEY:
        for path in ["/aq/observation/zipCode/current/", "/aq/forecast/zipCode/"]:
            r = c.get("https://www.airnowapi.org" + path, params={"format": "application/json", "zipCode": "44224", "distance": "25", "API_KEY": KEY})
            print("=== AirNow", path, r.status_code, r.headers.get("content-type"), "| body:", red(r.text[:300]), "| key len", len(KEY), "| has space:", KEY != KEY.strip())
    else:
        print("=== AirNow: AIRNOW_API_KEY not provided to probe")
