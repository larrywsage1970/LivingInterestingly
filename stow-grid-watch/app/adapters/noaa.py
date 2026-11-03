"""NOAA: Space Weather Prediction Center (grid-relevant geomagnetic storms) and
Storm Prediction Center (severe storm / tornado outlooks). Free, no key. Verified live 2026-11-03.

SWPC  services.swpc.noaa.gov/products/noaa-scales.json
      key "0" = current conditions, "1".."3" = forecast days. G scale 0-5 (NOAA's own scale).
      Banner: observed G5 -> Red, observed G4 -> Amber, forecast G4+ -> Amber (labeled forecast).
      G4/G5 storms are the level at which NOAA warns of possible grid voltage/transformer problems.

SPC   www.spc.noaa.gov/products/outlook/day{1,2,3}otlk_cat.lyr.geojson (+ day1 tornado layer)
      Polygons; GRID checks whether the location falls inside each risk area.
      Categorical risk (SPC's own labels): TSTM < MRGL < SLGT < ENH < MDT < HIGH.
      Banner: Day 1 MDT or HIGH -> Amber (a forecast, never Red: only an issued warning is Red).
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx

from app.adapters.base import item, result
from app.config import Location

SWPC_SCALES = "https://services.swpc.noaa.gov/products/noaa-scales.json"
SWPC_HOME = "https://www.swpc.noaa.gov/"
G_TEXT = {0: "none", 1: "minor", 2: "moderate", 3: "strong", 4: "severe", 5: "extreme"}

SPC_URL = "https://www.spc.noaa.gov/products/outlook/day{day}otlk_{layer}.lyr.geojson"
SPC_HOME = "https://www.spc.noaa.gov/products/outlook/"
# SPC categorical DN codes -> label, rank
SPC_CAT = {2: ("TSTM", "general thunderstorms"), 3: ("MRGL", "marginal risk"), 4: ("SLGT", "slight risk"),
           5: ("ENH", "enhanced risk"), 6: ("MDT", "moderate risk"), 8: ("HIGH", "high risk")}


# ---------------- SWPC ----------------

def _g(entry: dict | None) -> int | None:
    try:
        return int(((entry or {}).get("G") or {}).get("Scale"))
    except (TypeError, ValueError):
        return None


def parse_swpc(payload: dict) -> list[dict]:
    items = []
    now = payload.get("0") or {}
    g_now = _g(now)
    stamp = f"{now.get('DateStamp', '')}T{now.get('TimeStamp', '00:00:00')}+00:00" if now.get("DateStamp") else None
    if g_now is not None:
        items.append(item(
            "spaceweather",
            title=f"Geomagnetic storm level now: G{g_now} ({G_TEXT.get(g_now, '?')})",
            url=SWPC_HOME, severity=f"G{g_now}", starts=stamp,
            raw_excerpt="NOAA G scale: G1 minor ... G4 severe (possible grid voltage control problems) ... G5 extreme.",
            g_scale=g_now, observed=True, sender="NOAA SWPC",
        ))
    fc = [(k, _g(payload.get(k)), (payload.get(k) or {}).get("DateStamp")) for k in ("1", "2", "3")]
    fc = [(k, g, d) for k, g, d in fc if g is not None]
    if fc:
        k, g_max, day = max(fc, key=lambda x: x[1])
        items.append(item(
            "forecast",
            title=f"Geomagnetic storm forecast, next 3 days: up to G{g_max} ({G_TEXT.get(g_max, '?')})",
            url=SWPC_HOME, starts=f"{day}T00:00:00+00:00" if day else None,
            raw_excerpt="NOAA SWPC 3-day forecast of the geomagnetic (G) scale.",
            g_scale=g_max, observed=False, sender="NOAA SWPC", hazard_mentions=[],
        ))
    return items


async def fetch_swpc(client: httpx.AsyncClient, loc: Location) -> dict:
    r = await client.get(SWPC_SCALES)
    r.raise_for_status()
    return result("noaa_swpc", "NOAA space weather (grid storms)", parse_swpc(r.json()))


# ---------------- SPC ----------------

def _in_ring(lon: float, lat: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def point_in_geometry(lon: float, lat: float, geom: dict) -> bool:
    polys = geom.get("coordinates") or []
    if geom.get("type") == "Polygon":
        polys = [polys]
    elif geom.get("type") != "MultiPolygon":
        return False
    for poly in polys:
        if poly and _in_ring(lon, lat, poly[0]) and not any(_in_ring(lon, lat, h) for h in poly[1:]):
            return True
    return False


def parse_spc(day: int, cat: dict, torn: dict | None, loc: Location) -> list[dict]:
    best, props = None, None
    for f in cat.get("features", []):
        dn = (f.get("properties") or {}).get("DN")
        if dn in SPC_CAT and point_in_geometry(loc.lon, loc.lat, f.get("geometry") or {}):
            if best is None or dn > best:
                best, props = dn, f["properties"]
    torn_pct = None
    for f in (torn or {}).get("features", []):
        dn = (f.get("properties") or {}).get("DN")
        if isinstance(dn, (int, float)) and point_in_geometry(loc.lon, loc.lat, f.get("geometry") or {}):
            torn_pct = max(torn_pct or 0, dn)
    if best is None:
        return []
    label, words = SPC_CAT[best]
    title = f"Day {day} severe weather outlook: {label} ({words}) for Stow"
    if torn_pct:
        title += f" · tornado probability {torn_pct}%"
    return [item(
        "forecast",
        title=title, url=SPC_HOME, severity=label,
        starts=props.get("VALID_ISO"), ends=props.get("EXPIRE_ISO"),
        raw_excerpt=f"NOAA Storm Prediction Center convective outlook, issued {props.get('ISSUE_ISO', '')}.",
        spc_day=day, spc_category=label, spc_rank=best, tornado_pct=torn_pct,
        sender="NOAA Storm Prediction Center", hazard_mentions=["severe storms"],
    )]


async def fetch_spc(client: httpx.AsyncClient, loc: Location) -> dict:
    items = []
    for day in (1, 2, 3):
        cat = await client.get(SPC_URL.format(day=day, layer="cat"))
        cat.raise_for_status()
        torn = None
        if day == 1:
            t = await client.get(SPC_URL.format(day=1, layer="torn"))
            torn = t.json() if t.status_code == 200 else None
        items += parse_spc(day, cat.json(), torn, loc)
    return result("noaa_spc", "NOAA severe storm & tornado outlook", items)
