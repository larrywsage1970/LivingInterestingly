"""Temporary probe: OHGO public API shape near Stow. Never prints the key."""
import json, os
import httpx

KEY = os.environ.get("OHGO_API_KEY", "").strip()
UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}
B = "https://publicapi.ohgo.com/api/v1"


def red(s):
    return s.replace(KEY, "***") if KEY else s


print("key present:", bool(KEY), "len", len(KEY), "| in secrets:", os.environ.get("OHGO_IN_SECRET"), "| in variables:", os.environ.get("OHGO_IN_VAR"))
with httpx.Client(timeout=30, headers=UA, follow_redirects=True) as c:
    for path, params, hdr in [
        ("/incidents", {"radius": "41.1595,-81.4404,15"}, {"Authorization": f"APIKEY {KEY}"}),
        ("/incidents", {"radius": "41.1595,-81.4404,15", "api-key": KEY}, {}),
        ("/incidents", {"region": "akron"}, {"Authorization": f"APIKEY {KEY}"}),
        ("/construction", {"radius": "41.1595,-81.4404,15"}, {"Authorization": f"APIKEY {KEY}"}),
        ("/dangerous-slowdowns", {"radius": "41.1595,-81.4404,15"}, {"Authorization": f"APIKEY {KEY}"}),
    ]:
        try:
            r = c.get(B + path, params=params, headers=hdr)
        except Exception as e:  # noqa: BLE001
            print("===", path, "ERR", type(e).__name__); continue
        print(f"=== {path} {sorted(k for k in params if k != 'api-key')} auth={'header' if hdr else 'query'} -> HTTP {r.status_code} {r.headers.get('content-type')}")
        try:
            d = r.json()
        except Exception:
            print("  ", red(r.text[:300])); continue
        if isinstance(d, dict):
            print("   keys:", list(d)[:10], "| totalResultCount:", d.get("totalResultCount"))
            res = d.get("results") or []
            for x in res[:3]:
                print("   item:", red(json.dumps({k: x[k] for k in list(x)[:20]})[:700]))
            if not res:
                print("   body:", red(json.dumps(d)[:400]))
