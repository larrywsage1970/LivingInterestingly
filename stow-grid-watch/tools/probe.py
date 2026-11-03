"""Temporary probe 2: CDC HAN archive JSON shape; AirNow retirement notice / replacement."""
import json, os, re
import httpx

UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}
KEY = os.environ.get("AIRNOW_API_KEY", "")
with httpx.Client(timeout=30, headers=UA, follow_redirects=True) as c:
    for u in ["https://www.cdc.gov/han/php/modules/han-archive.json", "https://www.cdc.gov/han/php/modules/han-archive.static.json"]:
        r = c.get(u)
        print("===", u, r.status_code, r.headers.get("content-type"), len(r.content))
        try:
            d = r.json()
        except Exception:
            print("  not json:", r.text[:200]); continue
        def shape(v, depth=0):
            if isinstance(v, dict): return {k: shape(x, depth+1) for k, x in list(v.items())[:12]} if depth < 3 else "{..}"
            if isinstance(v, list): return [shape(v[0], depth+1), f"len={len(v)}"] if v else []
            return type(v).__name__
        print("  shape:", json.dumps(shape(d))[:1200])
        rows = d if isinstance(d, list) else next((v for v in d.values() if isinstance(v, list)), [])
        for row in rows[:4]:
            print("  row:", json.dumps(row)[:500])
    r = c.get("https://docs.airnowapi.org/webservices/retired")
    t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>", " ", r.text, flags=re.S)))
    print("=== AirNow retired page", r.status_code, "|", t[:1800])
    print("  links:", sorted(set(re.findall(r'href="([^"]+)"', r.text)))[:30])
