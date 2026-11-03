"""EIA Open Data API v2: hourly PJM demand (type D) and day-ahead demand forecast (type DF).

Route: /v2/electricity/rto/region-data/data/, respondent PJM, frequency=hourly (UTC periods,
"YYYY-MM-DDTHH", each value = MWh in that hour = average MW). Needs EIA_API_KEY.

Shown as context, not as an event: no severity, no banner effect. The key is never written
into an item, URL, or error message (the published snapshot is public).
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import httpx

from app.adapters.base import item, result
from app.config import Location

API = "https://api.eia.gov/v2/electricity/rto/region-data/data/"
PUBLIC_URL = "https://www.eia.gov/electricity/gridmonitor/dashboard/electric_overview/balancing_authority/PJM"
WINDOW = timedelta(days=7)


def _period(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def parse(payload: dict, now: datetime, respondent: str = "PJM") -> list[dict]:
    rows = payload.get("response", {}).get("data", []) or []
    demand, forecast = [], []
    for r in rows:
        if r.get("respondent") != respondent or not r.get("period"):
            continue
        v = _num(r.get("value"))
        if v is None:
            continue
        p = _period(r["period"])
        (demand if r.get("type") == "D" else forecast if r.get("type") == "DF" else []).append((p, v))
    if not demand:
        raise ValueError("EIA returned no PJM demand values")

    latest_p, latest_v = max(demand)
    window = [(p, v) for p, v in demand if p > latest_p - WINDOW]
    peak_p, peak_v = max(window, key=lambda x: x[1])
    pct = round(100 * latest_v / peak_v)
    items = [item(
        "observation",
        title=f"PJM demand {latest_v:,.0f} MW · {pct}% of 7-day peak ({peak_v:,.0f} MW)",
        url=PUBLIC_URL,
        starts=latest_p.isoformat(), ends=(latest_p + timedelta(hours=1)).isoformat(),
        raw_excerpt="EIA hourly demand (type D) for PJM. Each value is MWh for the hour (average MW).",
        value_mw=latest_v, peak_7d_mw=peak_v, peak_7d_at=peak_p.isoformat(), pct_of_peak=pct,
        data_lag_h=round((now - latest_p).total_seconds() / 3600, 1),
    )]
    ahead = [(p, v) for p, v in forecast if latest_p < p <= now + timedelta(hours=24)]
    if ahead:
        fp, fv = max(ahead, key=lambda x: x[1])
        items.append(item(
            "forecast",
            title=f"PJM forecast peak next 24h: {fv:,.0f} MW · {round(100 * fv / peak_v)}% of 7-day peak",
            url=PUBLIC_URL, starts=fp.isoformat(), ends=(fp + timedelta(hours=1)).isoformat(),
            raw_excerpt="EIA day-ahead demand forecast (type DF) for PJM, as published by PJM.",
            value_mw=fv,
        ))
    return items


async def fetch(client: httpx.AsyncClient, loc: Location) -> dict:
    key = os.environ.get("EIA_API_KEY", "").strip()
    if not key:
        return result("eia_pjm", "EIA · PJM demand", error="EIA_API_KEY is not set")
    now = datetime.now(timezone.utc)
    params = [
        ("api_key", key), ("frequency", "hourly"), ("data[0]", "value"),
        ("facets[respondent][]", loc.grid_operator), ("facets[type][]", "D"), ("facets[type][]", "DF"),
        ("start", (now - WINDOW - timedelta(days=1)).strftime("%Y-%m-%dT%H")),
        ("end", (now + timedelta(days=2)).strftime("%Y-%m-%dT%H")),
        ("sort[0][column]", "period"), ("sort[0][direction]", "desc"), ("length", "1000"),
    ]
    try:
        r = await client.get(API, params=params)
    except httpx.HTTPError as exc:
        return result("eia_pjm", "EIA · PJM demand", error=f"{type(exc).__name__} contacting EIA")
    if r.status_code != 200:
        # Never echo the request URL: it carries the key.
        return result("eia_pjm", "EIA · PJM demand", error=f"EIA HTTP {r.status_code}")
    try:
        items = parse(r.json(), now, loc.grid_operator)
    except ValueError as exc:
        return result("eia_pjm", "EIA · PJM demand", error=str(exc))
    return result("eia_pjm", "EIA · PJM demand", items)
