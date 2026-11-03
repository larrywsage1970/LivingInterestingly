"""Temporary: run the real NTAS and USGS adapters live, then the full snapshot."""
import asyncio
import httpx
from app.adapters import dhs, usgs
from app.config import BASE_DIR, load_locations


async def main():
    _, locs = load_locations(BASE_DIR / "locations.json")
    loc = locs["stow-44224"]
    async with httpx.AsyncClient(timeout=25, follow_redirects=True,
                                 headers={"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}) as c:
        for mod in (dhs, usgs):
            r = await mod.fetch(c, loc)
            print(r["source"], "ok:", r["ok"], "| error:", r.get("error"), "| items:", len(r["items"]))
            for i in r["items"][:5]:
                print("  -", i["title"], "|", i["starts"])

asyncio.run(main())
