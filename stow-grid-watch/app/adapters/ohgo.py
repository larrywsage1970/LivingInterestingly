"""OHGO (Ohio Department of Transportation) public API: crashes, road closures and
dangerous slowdowns near the location. Verified live 2026-11-04.

    https://publicapi.ohgo.com/api/v1/{incidents,construction,dangerous-slowdowns}
    ?radius=<lat>,<lon>,<miles>   header  Authorization: APIKEY <key>   (env OHGO_API_KEY)

Roads never color the banner: a crash or a closed road is not an area emergency.
Items are flagged `notable` for the simple view only when they are happening now and
are new: incidents, dangerous slowdowns, and full closures that began in the last 3 days.
Long-running work zones and lane restrictions are kept for the details view.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx

from app.adapters.base import item, result
from app.config import Location

API = "https://publicapi.ohgo.com/api/v1"
HOME = "https://www.ohgo.com/"
LABEL = "OHGO Ohio roads (ODOT)"
RADIUS_MI = 10
NEW_CLOSURE_DAYS = 3


def _key() -> str:
    return (os.environ.get("OHGO_API_KEY") or os.environ.get("OHGO_API_KE") or "").strip()


def _local(s: str | None, tz: str) -> datetime | None:
    """OHGO construction dates are local wall-clock times without an offset."""
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d.replace(tzinfo=ZoneInfo(tz)) if d.tzinfo is None else d


def _iso(d: datetime | None) -> str | None:
    return d.astimezone(timezone.utc).isoformat() if d else None


def parse_incidents(results: list[dict]) -> list[dict]:
    out = []
    for x in results or []:
        cat = (x.get("category") or "Incident").strip()
        where = (x.get("location") or x.get("routeName") or "").strip()
        closed = (x.get("roadStatus") or "").lower() == "closed"
        details = (x.get("description") or "").strip()
        if x.get("roadClosureDetails"):
            details += f"\n\nClosure: {x['roadClosureDetails']}"
        out.append(item("road", title=f"{cat}{' · road closed' if closed else ''}: {where}".strip(": "),
                        url=HOME, raw_excerpt=details, sender="ODOT (OHGO)", origin="ohgo",
                        road_type="incident", road_closed=closed, notable=True, id=x.get("id")))
    return out


def parse_slowdowns(results: list[dict]) -> list[dict]:
    out = []
    for x in results or []:
        where = (x.get("location") or x.get("routeName") or "").strip()
        cur, norm = x.get("currentMPH"), x.get("normalMPH")
        speed = f"Traffic moving about {cur} mph (normally {norm} mph)." if cur is not None and norm else ""
        out.append(item("road", title=f"Sudden slowdown: {where}", url=HOME,
                        raw_excerpt=" ".join(p for p in (speed, x.get("description") or "") if p),
                        sender="ODOT (OHGO)", origin="ohgo", road_type="slowdown", notable=True, id=x.get("id")))
    return out


def parse_construction(results: list[dict], now: datetime, tz: str) -> list[dict]:
    """Closures in effect now (one per project, not one per direction). Lane restrictions kept, not notable."""
    seen, out = set(), []
    for x in results or []:
        status = (x.get("status") or "").lower()
        if status not in ("closed", "restricted"):
            continue
        start, end = _local(x.get("startDate"), tz), _local(x.get("endDate"), tz)
        if (start and start > now) or (end and end < now):
            continue
        desc = (x.get("description") or "").strip()
        dedupe = (x.get("workZoneProjectId") or x.get("routeName"), desc)
        if dedupe in seen:
            continue
        seen.add(dedupe)
        closed = status == "closed"
        new = bool(closed and start and now - start <= timedelta(days=NEW_CLOSURE_DAYS))
        route = (x.get("routeName") or x.get("location") or "").strip()
        out.append(item("road", title=f"{'Road closed' if closed else 'Lane restrictions'}: {route}",
                        url=HOME, starts=_iso(start), ends=_iso(end), raw_excerpt=desc,
                        sender="ODOT (OHGO)", origin="ohgo", road_type="closure" if closed else "restriction",
                        road_closed=closed, notable=new, id=x.get("id")))
    # Closures first, newest first.
    out.sort(key=lambda i: (not i["road_closed"], -(datetime.fromisoformat(i["starts"]).timestamp() if i["starts"] else 0)))
    return out


async def fetch(client: httpx.AsyncClient, loc: Location) -> dict:
    key = _key()
    if not key:
        return result("ohgo", LABEL, error="OHGO_API_KEY not set")
    params = {"radius": f"{loc.lat},{loc.lon},{RADIUS_MI}"}
    headers = {"Authorization": f"APIKEY {key}"}

    async def get(path: str) -> list[dict]:
        r = await client.get(f"{API}/{path}", params=params, headers=headers)
        r.raise_for_status()
        return r.json().get("results") or []

    now = datetime.now(timezone.utc)
    items = (parse_incidents(await get("incidents"))
             + parse_slowdowns(await get("dangerous-slowdowns"))
             + parse_construction(await get("construction"), now, loc.tz))
    return result("ohgo", LABEL, items)
