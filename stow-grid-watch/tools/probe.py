"""Temporary probe 2: CDC HAN feed location, NRC item detail, CISA/SPC fields."""
import json, re
import httpx

UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}


def text(h):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h))


with httpx.Client(timeout=30, headers=UA, follow_redirects=True) as c:
    r = c.get("https://www.cdc.gov/rss/index.html")
    print("=== cdc rss index", r.status_code, r.url)
    for m in re.finditer(r'href="([^"]+\.rss[^"]*)"[^>]*>(.*?)</a>', r.text, re.S):
        if re.search(r"han|health alert|emergenc", m.group(0), re.I):
            print("   ", m.group(1), "|", text(m.group(2))[:80])
    for cand in ["https://tools.cdc.gov/api/v2/resources/media/285676.rss", "https://tools.cdc.gov/api/v2/resources/media/132608.rss",
                 "https://www2c.cdc.gov/podcasts/createrss.asp?c=146"]:
        rr = c.get(cand)
        titles = re.findall(r"<item>.*?<title>(.*?)</title>", rr.text, re.S)[:3]
        ch = re.search(r"<channel>.*?<title>(.*?)</title>", rr.text, re.S)
        print("=== ", cand, rr.status_code, "| channel:", ch.group(1)[:80] if ch else None, "| items:", titles)
    r = c.get("https://www.cdc.gov/han/php/notices/index.html")
    links = sorted(set(re.findall(r'href="(/han/[^"]*han\d+[^"]*)"', r.text)))[:5]
    print("=== HAN notices links:", links, "| total", len(set(re.findall(r'han\d{5}', r.text))))

    r = c.get("https://www.nrc.gov/public-involve/rss?feed=event")
    print("=== NRC raw:", r.text[:1200].replace("\n", " "))
    links = re.findall(r"<link>(.*?)</link>", r.text)
    if len(links) > 1:
        d = c.get(links[1].strip())
        t = text(d.text)
        for kw in ["Facility", "Emergency Class", "EMERGENCY CLASS", "Event Date", "Notification Date", "Region", "State"]:
            m = re.search(kw, t)
            if m: print(f"  [{kw}] {t[m.start():m.start()+200]}")

    r = c.get("https://www.cisa.gov/cybersecurity-advisories/cybersecurity-advisories.xml")
    first = re.search(r"<item>(.*?)</item>", r.text, re.S).group(1)
    print("=== CISA item tags:", sorted(set(re.findall(r"<([a-zA-Z:]+)[ >]", first))))
    print("    pubDate:", re.search(r"<pubDate>(.*?)</pubDate>", first).group(1) if "<pubDate>" in first else None,
          "| link:", re.search(r"<link>(.*?)</link>", first).group(1) if "<link>" in first else None,
          "| desc len:", len(re.search(r"<description>(.*?)</description>", first, re.S).group(1)) if "<description>" in first else None)

    r = c.get("https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson")
    print("=== SPC cat props:", json.dumps(r.json()["features"][0]["properties"]))
    r = c.get("https://www.spc.noaa.gov/products/outlook/day1otlk_torn.lyr.geojson")
    print("=== SPC torn props:", json.dumps(r.json()["features"][0]["properties"]))
    r = c.get("https://services.swpc.noaa.gov/products/noaa-scales.json")
    d = r.json(); print("=== SWPC -1:", json.dumps(d.get("-1"))[:300])
