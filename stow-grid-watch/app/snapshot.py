"""Static build for GitHub Pages: poll every source once and write the site with a status snapshot.

    python -m app.snapshot --out site [--previous-url https://<user>.github.io/<repo>/]

Static hosting has no database, so last-good values carry over through the previously
published snapshot: it is downloaded, its last-good items are loaded as the history,
and then this run's fetches are recorded on top. A failing feed therefore still shows
"unavailable, last good value at HH:MM" instead of going blank.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app import poller
from app.adapters.base import TIMEOUT
from app.config import BASE_DIR, get_settings, load_locations
from app.payload import build_payload
from app.sources import BY_ID, SOURCES
from app.store import Store


def status_file(loc_id: str) -> str:
    return f"api/status-{loc_id}.json"


def seed_from_previous(store: Store, loc_id: str, previous: dict | None) -> int:
    seeded = 0
    for sid, card in ((previous or {}).get("cards") or {}).items():
        if sid in BY_ID and card.get("last_good_at"):
            store.save(loc_id, {"source": sid, "label": BY_ID[sid].label, "ok": True,
                                "fetched_at": card["last_good_at"], "items": card.get("items", [])})
            seeded += 1
    return seeded


async def fetch_previous(client: httpx.AsyncClient, base_url: str | None, loc_id: str) -> dict | None:
    if not base_url:
        return None
    try:
        r = await client.get(base_url.rstrip("/") + "/" + status_file(loc_id),
                             headers={"Cache-Control": "no-cache"})
        return r.json() if r.status_code == 200 else None
    except Exception:  # noqa: BLE001 - first deploy or Pages down: start clean
        return None


async def build(out: Path, previous_url: str | None, client: httpx.AsyncClient | None = None) -> dict:
    settings = get_settings()
    default_loc, locations = load_locations(settings.locations_file)
    own = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": settings.user_agent},
                                         follow_redirects=True)
    try:
        if out.exists():
            shutil.rmtree(out)
        shutil.copytree(BASE_DIR / "static", out)
        (out / "api").mkdir(exist_ok=True)

        html = (out / "index.html").read_text()
        (out / "index.html").write_text(html.replace(
            '<meta name="sgw-mode" content="server">', '<meta name="sgw-mode" content="static">'))

        summary = {}
        for loc in locations.values():
            store = Store(":memory:")
            seed_from_previous(store, loc.id, await fetch_previous(client, previous_url, loc.id))
            await poller.poll_all(SOURCES, client, loc, store)
            payload = build_payload(store, loc, datetime.now(timezone.utc))
            payload["mode"] = "static"
            text = json.dumps(payload, indent=1)
            (out / status_file(loc.id)).write_text(text)
            if loc.id == default_loc:
                (out / "api" / "status.json").write_text(text)
            summary[loc.id] = {"color": payload["banner"]["color"], "rule": payload["banner"]["rule"],
                               "feeds": {k: v["state"] for k, v in payload["cards"].items()}}
        (out / ".nojekyll").write_text("")
        return summary
    finally:
        if own:
            await client.aclose()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site")
    ap.add_argument("--previous-url", default=None)
    a = ap.parse_args()
    summary = asyncio.run(build(Path(a.out), a.previous_url))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
