"""FastAPI app: read-only status API + static PWA."""
from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import poller
from app.adapters.base import TIMEOUT
from app.config import BASE_DIR, get_settings, load_locations
from app.sources import SOURCES
from app.payload import build_payload
from app.store import Store

VERSION = "0.1.0"
REFRESH_MIN_INTERVAL_S = 60


def create_app(store: Store | None = None, client: httpx.AsyncClient | None = None,
               poll: bool | None = None,
               refresh_min_interval_s: int = REFRESH_MIN_INTERVAL_S) -> FastAPI:
    settings = get_settings()
    default_loc, locations = load_locations(settings.locations_file)
    state: dict = {"last_refresh": {}}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state["store"] = store or Store(settings.db_path)
        state["client"] = client or httpx.AsyncClient(
            timeout=TIMEOUT, headers={"User-Agent": settings.user_agent}, follow_redirects=True)
        tasks = []
        if settings.poll if poll is None else poll:
            for loc in locations.values():
                for spec in SOURCES:
                    tasks.append(asyncio.create_task(poller.loop(spec, state["client"], loc, state["store"])))
            tasks.append(asyncio.create_task(poller.prune_loop(state["store"])))
        yield
        for t in tasks:
            t.cancel()
        if client is None:
            await state["client"].aclose()

    app = FastAPI(title="GRID", version=VERSION, lifespan=lifespan)

    def _loc(location_id: str | None):
        loc = locations.get(location_id or default_loc)
        if not loc:
            raise HTTPException(404, "unknown location")
        return loc

    def _status_payload(loc) -> dict:
        return build_payload(state["store"], loc, datetime.now(timezone.utc))

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": VERSION, "locations": list(locations)}

    @app.get("/api/locations")
    def list_locations():
        return {"default": default_loc,
                "locations": [{"id": l.id, "name": l.name} for l in locations.values()]}

    @app.get("/api/status")
    def get_status(location: str | None = Query(None)):
        return JSONResponse(_status_payload(_loc(location)), headers={"Cache-Control": "no-store"})

    @app.post("/api/refresh")
    async def refresh(location: str | None = Query(None)):
        loc = _loc(location)
        last = state["last_refresh"].get(loc.id, 0)
        if not last or time.monotonic() - last >= refresh_min_interval_s:
            state["last_refresh"][loc.id] = time.monotonic()
            await poller.poll_all(SOURCES, state["client"], loc, state["store"])
        return JSONResponse(_status_payload(loc), headers={"Cache-Control": "no-store"})

    app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")
    return app


app = create_app()
