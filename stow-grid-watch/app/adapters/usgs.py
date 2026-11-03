"""USGS earthquakes near the location (FDSN event service, GeoJSON). Free, no key.

Query: last 7 days, within 300 km, magnitude >= 2.5 (verified live 2026-11-03).
Severity comes from USGS itself: the PAGER `alert` level (green/yellow/orange/red) when
USGS assigns one. Banner: PAGER orange/red -> Red, PAGER yellow -> Amber; otherwise a
quake of M4.5+ within 150 km in the last 24 h -> Amber (shown as GRID's rule, not USGS's).
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import httpx

from app.adapters.base import item, result
from app.config import Location

API = "https://earthquake.usgs.gov/fdsnws/event/1/query"
HOME = "https://earthquake.usgs.gov/earthquakes/map/"
RADIUS_KM = 300


def _km(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def parse(payload: dict, loc: Location, now: datetime) -> list[dict]:
    items = []
    for f in payload.get("features", []):
        p = f.get("properties", {})
        coords = (f.get("geometry") or {}).get("coordinates") or [None, None]
        if p.get("time") is None or p.get("mag") is None or coords[0] is None:
            continue
        when = datetime.fromtimestamp(p["time"] / 1000, tz=timezone.utc)
        dist = round(_km(loc.lat, loc.lon, coords[1], coords[0]))
        pager = p.get("alert")   # USGS PAGER level, or None
        items.append(item(
            "quake",
            title=f"M{p['mag']:.1f} earthquake · {p.get('place') or 'location not given'} · {dist} km away",
            url=p.get("url") or HOME,
            severity=f"PAGER {pager}" if pager else None,
            starts=when.isoformat(),
            raw_excerpt=p.get("title") or "",
            magnitude=p["mag"], distance_km=dist, pager=pager,
            recent_24h=(now - when) <= timedelta(hours=24),
            sender="USGS",
        ))
    items.sort(key=lambda i: i["starts"], reverse=True)
    return items


async def fetch(client: httpx.AsyncClient, loc: Location) -> dict:
    now = datetime.now(timezone.utc)
    params = {
        "format": "geojson", "latitude": f"{loc.lat:.4f}", "longitude": f"{loc.lon:.4f}",
        "maxradiuskm": str(RADIUS_KM), "minmagnitude": "2.5",
        "starttime": (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S"),
        "orderby": "time", "limit": "20",
    }
    r = await client.get(API, params=params)
    r.raise_for_status()
    return result("usgs_quakes", "USGS earthquakes (300 km, 7 days)", parse(r.json(), loc, now))
