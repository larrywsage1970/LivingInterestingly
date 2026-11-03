"""Temporary probe 3: HAN static JSON doc fields; AirNow public file products."""
import json, re
import httpx

UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}
with httpx.Client(timeout=30, headers=UA, follow_redirects=True) as c:
    d = c.get("https://www.cdc.gov/han/php/modules/han-archive.static.json").json()
    docs = d["response"]["docs"]
    print("=== HAN numFound", d["response"]["numFound"], "| doc keys:", sorted(docs[0].keys()))
    for doc in docs[:4]:
        print("  doc:", json.dumps({k: (v[:120] if isinstance(v, str) else v) for k, v in doc.items()
                                    if re.search(r"title|url|date|desc|type|name|topic", k, re.I)})[:700])
    for u in ["https://files.airnowtech.org/airnow/today/reportingarea.dat",
              "https://files.airnowtech.org/airnow/today/reportingarea.xml"]:
        r = c.get(u)
        print("===", u, r.status_code, r.headers.get("content-type"), len(r.content), "| last-modified:", r.headers.get("last-modified"))
        if r.status_code == 200:
            lines = [l for l in r.text.splitlines() if "Akron" in l or "Canton" in l or "Cleveland" in l][:6]
            print("  head:", r.text[:300].replace("\n", " || "))
            for l in lines:
                print("  match:", l[:300])
