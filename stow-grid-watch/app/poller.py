"""Background polling: one asyncio loop per (location, source). No external scheduler."""
from __future__ import annotations

import asyncio
import logging

import httpx

from app.adapters.base import SourceSpec, run
from app.config import Location
from app.store import Store

log = logging.getLogger("sgw.poller")


async def poll_once(spec: SourceSpec, client: httpx.AsyncClient, loc: Location, store: Store) -> dict:
    res = await run(spec, client, loc)
    store.save(loc.id, res)
    if not res["ok"]:
        log.warning("%s/%s failed: %s", loc.id, spec.id, res.get("error"))
    return res


async def poll_all(sources, client, loc, store) -> None:
    await asyncio.gather(*(poll_once(s, client, loc, store) for s in sources))


async def loop(spec: SourceSpec, client: httpx.AsyncClient, loc: Location, store: Store) -> None:
    while True:
        await poll_once(spec, client, loc, store)
        await asyncio.sleep(spec.cadence_s)


async def prune_loop(store: Store) -> None:
    while True:
        store.prune()
        await asyncio.sleep(6 * 3600)
