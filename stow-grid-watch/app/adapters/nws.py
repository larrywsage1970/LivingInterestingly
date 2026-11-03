"""National Weather Service (api.weather.gov). Free, no key; requires a User-Agent."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import httpx

from app.adapters.base import item, result
from app.config import Location

API = "https://api.weather.gov"
GEOJSON = {"Accept": "application/geo+json"}

HAZARD_WORDS = re.compile(
    r"\b(snow|ice|icy|freezing rain|freezing drizzle|sleet|blizzard|wind chill|"
    r"thunderstorm|high wind|flood)\w*",
    re.IGNORECASE,
)


def _dt(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


# ---------- alerts ----------

def parse_alerts(payload: dict) -> list[dict]:
    items = []
    for feat in payload.get("features", []):
        p = feat.get("properties", {})
        if p.get("status") != "Actual":          # drop Test / Exercise / Draft
            continue
        if p.get("messageType") == "Cancel":
            continue
        event = p.get("event") or "Alert"
        items.append(item(
            "alert",
            title=p.get("headline") or event,
            url=p.get("@id") or feat.get("id") or f"{API}/alerts",
            severity=p.get("severity"),
            starts=p.get("onset") or p.get("effective"),
            ends=p.get("ends") or p.get("expires"),
            raw_excerpt=p.get("description") or "",
            event=event,
            sender=p.get("senderName"),
            urgency=p.get("urgency"),
            certainty=p.get("certainty"),
            issued=p.get("sent"),
            origin="nws",
        ))
    return items


async def fetch_alerts(client: httpx.AsyncClient, loc: Location) -> dict:
    r = await client.get(f"{API}/alerts/active", params={"point": f"{loc.lat:.4f},{loc.lon:.4f}"},
                         headers=GEOJSON)
    r.raise_for_status()
    return result("nws_alerts", "NWS alerts", parse_alerts(r.json()))


# ---------- forecast ----------

def parse_forecast(payload: dict, forecast_url: str, now: datetime, hours: int = 48) -> list[dict]:
    horizon = now + timedelta(hours=hours)
    items = []
    for per in payload.get("properties", {}).get("periods", []):
        start, end = _dt(per.get("startTime")), _dt(per.get("endTime"))
        if not start or not end or end <= now or start >= horizon:
            continue
        is_low = not per.get("isDaytime", True)
        temp, unit = per.get("temperature"), per.get("temperatureUnit", "F")
        text = f"{per.get('shortForecast', '')}. {per.get('detailedForecast', '')}"
        hazards = sorted({m.group(0).lower() for m in HAZARD_WORDS.finditer(text)})
        label = "Low" if is_low else "High"
        items.append(item(
            "forecast",
            title=f"{per.get('name')}: {label} {temp}°{unit} · {per.get('shortForecast', '')}",
            url=forecast_url,
            starts=per.get("startTime"),
            ends=per.get("endTime"),
            raw_excerpt=per.get("detailedForecast") or "",
            period=per.get("name"),
            is_low=is_low,
            temperature=temp,
            temperature_unit=unit,
            hazard_mentions=hazards,
        ))
    return items


async def fetch_forecast(client: httpx.AsyncClient, loc: Location) -> dict:
    pt = await client.get(f"{API}/points/{loc.lat:.4f},{loc.lon:.4f}", headers=GEOJSON)
    pt.raise_for_status()
    forecast_url = pt.json()["properties"]["forecast"]
    fc = await client.get(forecast_url, headers=GEOJSON)
    fc.raise_for_status()
    items = parse_forecast(fc.json(), forecast_url, datetime.now(timezone.utc))
    return result("nws_forecast", "NWS forecast", items)


def alerts_home(loc: Location) -> str:
    return f"https://forecast.weather.gov/MapClick.php?lat={loc.lat}&lon={loc.lon}"
