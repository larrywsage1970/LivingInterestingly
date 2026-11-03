"""Builds the status payload the frontend renders. Shared by the API server and the static snapshot."""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime

from app import status
from app.config import Location
from app.sources import SOURCES
from app.store import Store


def stale_after_s() -> int:
    """How old the whole payload may get before the phone shows Gray on its own."""
    return 2 * max(s.cadence_s for s in SOURCES if s.required)


def build_payload(store: Store, loc: Location, now: datetime) -> dict:
    feeds = [status.Feed(s, store.latest(loc.id, s.id), store.last_good(loc.id, s.id)) for s in SOURCES]
    banner = status.compute(feeds, loc, now)
    cards = {}
    for f, fs in zip(feeds, banner["feeds"]):
        # Last good data is shown even when a feed is failing; its state says so.
        cards[f.spec.id] = {**fs, "items": f.last_good["items"] if f.last_good else [],
                            "home_url": f.spec.home_url(loc)}
    return {
        "location": asdict(loc),
        "banner": {k: banner[k] for k in ("color", "rule", "additional_triggers", "triggers", "computed_at")},
        "stale_after_s": stale_after_s(),
        "cards": cards,
    }
