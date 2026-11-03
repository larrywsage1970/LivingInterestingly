"""Temporary probe 2: where the live PJM Emergency Procedures XML/RSS lives and its schema."""
import re
import httpx

UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}
B = "https://www.pjm.com"


def text(html: str) -> str:
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t))


with httpx.Client(timeout=25, headers=UA, follow_redirects=True) as c:
    r = c.get(B + "/markets-and-operations/etools/emerg-procedure.aspx")
    t = text(r.text)
    for kw in ["XML", "RSS", "subscribe", "API", "Data Miner", "terms"]:
        for m in list(re.finditer(kw, t))[:3]:
            print(f"[emerg page ~{kw}] ...{t[max(0, m.start()-220):m.end()+260]}...")
    print("\n=== sample-active-cwa.xml")
    s = c.get(B + "/-/media/DotCom/etools/emerg-procedures/sample-active-cwa.xml")
    print(s.status_code, s.headers.get("content-type"), "\n", s.text[:1800])
    print("\n=== epsample.xml (head)")
    print(c.get(B + "/-/media/DotCom/etools/emerg-procedures/epsample.xml").text[:900])
    for u in ["https://rss.pjm.com/", B + "/about-pjm/newsroom/rss-feeds"]:
        r = c.get(u)
        print(f"\n=== {u} HTTP {r.status_code} {r.headers.get('content-type')} final {r.url}")
        links = sorted(set(re.findall(r'href=["\']([^"\']+)["\']', r.text)))
        for l in links:
            if re.search(r"rss|xml|feed|emerg|ep", l, re.I):
                print("   ", l)
        tt = text(r.text)
        for m in list(re.finditer(r"[Ee]mergency", tt))[:4]:
            print("   ctx:", tt[max(0, m.start()-150):m.end()+200])
    for u in ["https://emergencyprocedures.pjm.com/ep/rss", "https://emergencyprocedures.pjm.com/ep/rss.xml",
              "https://emergencyprocedures.pjm.com/ep/pages/rss.jsf", "https://rss.pjm.com/emergencyprocedures",
              "https://rss.pjm.com/ep"]:
        r = c.get(u)
        print(f"\n=== {u} HTTP {r.status_code} {r.headers.get('content-type')} {len(r.content)}b final {r.url}")
        if r.status_code == 200 and ("xml" in (r.headers.get("content-type") or "") or r.text.lstrip().startswith("<?xml")):
            print(r.text[:1200])
