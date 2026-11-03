"""Temporary: run AirNow file + CDC adapters live, then the full snapshot."""
import asyncio, json
import httpx
from app.adapters import gov_extra
from app.config import BASE_DIR, load_locations


async def main():
    _, locs = load_locations(BASE_DIR / "locations.json")
    loc = locs["stow-44224"]
    async with httpx.AsyncClient(timeout=40, follow_redirects=True,
                                 headers={"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}) as c:
        for fn in (gov_extra.fetch_airnow, gov_extra.fetch_cdc):
            r = await fn(c, loc)
            print(r["source"], "ok:", r["ok"], "| error:", r.get("error"), "| items:", len(r["items"]))
            for i in r["items"][:6]:
                print("  -", i["title"][:160], "|", i.get("starts"))

    async with httpx.AsyncClient(timeout=40, follow_redirects=True) as c:
        import re
        t = (await c.get(gov_extra.CDC_OUTBREAKS)).text
        for m in re.findall(r"<item>(.*?)</item>", t, re.S)[:2]:
            print("CDC raw item:", re.sub(r"\s+", " ", m)[:500])

asyncio.run(main())
