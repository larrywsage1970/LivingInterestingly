"""Temporary: run the new adapters live, then the full snapshot."""
import asyncio
import httpx
from app.adapters import gov_extra, noaa
from app.config import BASE_DIR, load_locations


async def main():
    _, locs = load_locations(BASE_DIR / "locations.json")
    loc = locs["stow-44224"]
    async with httpx.AsyncClient(timeout=30, follow_redirects=True,
                                 headers={"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}) as c:
        for fn in (noaa.fetch_swpc, noaa.fetch_spc, gov_extra.fetch_cisa, gov_extra.fetch_nrc, gov_extra.fetch_airnow):
            try:
                r = await fn(c, loc)
            except Exception as e:  # noqa: BLE001
                print(fn.__name__, "EXCEPTION", type(e).__name__, str(e)[:200]); continue
            print(r["source"], "ok:", r["ok"], "| error:", r.get("error"), "| items:", len(r["items"]))
            for i in r["items"][:6]:
                print("  -", i["title"][:150], "|", i.get("starts"))

asyncio.run(main())
