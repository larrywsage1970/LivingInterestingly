"""Adapter contract.

Every adapter returns:
    {source, label, fetched_at, ok, items[], error?}
Each item:
    {kind, title, severity, starts, ends, url, raw_excerpt, ...source fields}

kind separates event from risk:
    "alert"        an alert/warning issued by an authority (an event)
    "declaration"  a formal emergency/disaster declaration (an event)
    "forecast"     a forecast (NOT an event)
    "observation"  a measured value, e.g. grid demand (context, NOT an event)
    "notice"       an operator's published announcement (news post), not a real-time alert
Severity is copied from the source or left None. Never invented.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Awaitable, Callable

import httpx

from app.config import Location

TIMEOUT = httpx.Timeout(15.0)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def item(kind: str, title: str, url: str, *, severity=None, starts=None, ends=None,
         raw_excerpt: str = "", **extra) -> dict:
    return {
        "kind": kind, "title": title, "severity": severity, "starts": starts,
        "ends": ends, "url": url, "raw_excerpt": (raw_excerpt or "")[:6000], **extra,
    }


def result(source: str, label: str, items: list[dict] | None = None, error: str | None = None) -> dict:
    out = {"source": source, "label": label, "fetched_at": now_iso(),
           "ok": error is None, "items": items or []}
    if error:
        out["error"] = error
    return out


@dataclass(frozen=True)
class SourceSpec:
    id: str
    label: str
    cadence_s: int          # poll interval
    required: bool          # required feeds drive Gray when stale/failing
    fetch: Callable[[httpx.AsyncClient, Location], Awaitable[dict]]
    home_url: Callable[[Location], str]


async def run(spec: SourceSpec, client: httpx.AsyncClient, loc: Location) -> dict:
    """Run an adapter; any exception becomes an ok=False result, never a crash."""
    try:
        return await spec.fetch(client, loc)
    except Exception as exc:  # noqa: BLE001 - report every failure as data
        return result(spec.id, spec.label, error=f"{type(exc).__name__}: {exc}"[:300])
