"""Temporary: run the real Inside Lines adapter live and print what it would publish."""
import asyncio, json
from datetime import datetime, timezone
import httpx
from app.adapters import pjm
from app.config import load_locations, BASE_DIR

async def main():
    _, locs = load_locations(BASE_DIR / "locations.json")
    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": "GRID/0.1 (contact: larrywsage@gmail.com)"}, follow_redirects=True) as c:
        res = await pjm.fetch(c, locs["stow-44224"])
    print("ok:", res["ok"], "| error:", res.get("error"), "| items:", len(res["items"]))
    for i in res["items"]:
        print(f" - {i['starts'][:16]} | ops_action={i['ops_action']} recent={i['recent']} | {i['title']}")

asyncio.run(main())
