"""Temporary probe 4: OHGO incident shape (statewide) and construction statuses near Stow. Never prints the key."""
import json, os, collections
import httpx

KEY = os.environ.get("OHGO_API_KEY", "").strip()
UA = {"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)", "Authorization": f"APIKEY {KEY}"}
B = "https://publicapi.ohgo.com/api/v1"
red = lambda s: s.replace(KEY, "***") if KEY else s

with httpx.Client(timeout=30, headers=UA) as c:
    d = c.get(B + "/incidents").json()
    res = d.get("results") or []
    print("statewide incidents:", d.get("totalResultCount"))
    print("categories:", collections.Counter(x.get("category") for x in res).most_common(20))
    print("roadStatus:", collections.Counter(x.get("roadStatus") for x in res).most_common(10))
    for x in res[:4]:
        print("INC:", red(json.dumps(x)[:900]))
    d = c.get(B + "/construction", params={"radius": "41.1595,-81.4404,15"}).json()
    res = d.get("results") or []
    print("near construction statuses:", collections.Counter((x.get("status"), x.get("category")) for x in res))
    for x in res:
        if x.get("status") != "Open":
            print("CON:", x.get("status"), "|", x.get("routeName"), "|", (x.get("description") or "")[:160], "|", x.get("startDate"), x.get("endDate"))
    print("keys:", list(res[0]) if res else None)
    d = c.get(B + "/dangerous-slowdowns").json()
    for x in (d.get("results") or [])[:2]:
        print("SLOW:", red(json.dumps(x)[:600]))
