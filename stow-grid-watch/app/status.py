"""Banner logic. Pure functions: source data in, color + one-line rule out.

Precedence (first match wins):
  1. RED    usable data shows: an NWS *Warning*; an IPAWS alert whose event is a
            Warning/Evacuation/Shelter order or whose CAP severity is Extreme; a DHS NTAS
            Imminent Threat Alert; or a nearby earthquake USGS rates PAGER orange/red.
  2. GRAY   any REQUIRED feed is failing, stale (> 2x cadence), or never fetched.
            Known Red is still shown; an unknown is never shown as Green or Amber.
  3. AMBER  NWS Watch or Advisory; any other active IPAWS alert; an active FEMA
            declaration for the county; a forecast low <= the location threshold; or a
            PJM post from the last 48h announcing an alert/advisory/emergency action; a DHS
            NTAS Elevated Threat Alert; or a nearby quake rated PAGER yellow, or M4.5+ within
            150 km in the last 24h.
  4. GREEN  none of the above and all required feeds fresh.

"Usable" data = the last good fetch of a feed, if it is no older than 2x cadence.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from app.adapters.base import SourceSpec
from app.config import Location

RED_IPAWS = re.compile(r"warning|evacuat|shelter", re.IGNORECASE)


def _dt(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def _stamp(s: str | None, tz: str) -> str:
    """Date and time in the location's zone, e.g. 'Nov 3, 11:09 AM EST'. The server runs in UTC."""
    d = _dt(s)
    if not d:
        return "--"
    local = d.astimezone(ZoneInfo(tz))
    return f"{local.strftime('%b')} {local.day}, {local.strftime('%I:%M %p').lstrip('0')} {local.strftime('%Z')}"


@dataclass
class Feed:
    spec: SourceSpec
    latest: dict | None
    last_good: dict | None


def feed_state(f: Feed, now: datetime) -> dict:
    max_age = 2 * f.spec.cadence_s
    lg_at = f.last_good["fetched_at"] if f.last_good else None
    age = (now - _dt(lg_at)).total_seconds() if lg_at else None
    usable = f.last_good if (age is not None and age <= max_age) else None
    if f.latest is None:
        state = "never"
    elif not f.latest["ok"]:
        state = "failing"
    elif usable is None:
        state = "stale"
    else:
        state = "fresh"
    return {
        "id": f.spec.id, "label": f.spec.label, "required": f.spec.required,
        "state": state, "cadence_s": f.spec.cadence_s,
        "last_attempt_at": f.latest["fetched_at"] if f.latest else None,
        "last_good_at": lg_at, "age_s": int(age) if age is not None else None,
        "error": f.latest.get("error") if f.latest and not f.latest["ok"] else None,
        "usable": usable is not None, "_data": usable,
    }


def _active(it: dict, now: datetime) -> bool:
    end = _dt(it.get("ends"))
    return end is None or end > now


def compute(feeds: list[Feed], loc: Location, now: datetime) -> dict:
    states = [feed_state(f, now) for f in feeds]
    red, amber = [], []

    for st in states:
        data = st["_data"]
        if not data:
            continue
        src, at = st["label"], _stamp(data["fetched_at"], loc.tz)
        for it in data["items"]:
            if it["kind"] == "alert" and _active(it, now):
                ev = it.get("event") or it["title"]
                if it.get("origin") == "ntas":
                    t = (it.get("ntas_type") or "").lower()
                    if "imminent" in t:
                        red.append(f"{ev} in effect ({src}, checked {at})")
                    elif "elevated" in t:
                        amber.append(f"{ev} in effect ({src}, checked {at})")
                    # Bulletins are shown on the board but do not color the banner.
                elif it.get("origin") == "nws":
                    if ev.endswith("Warning"):
                        red.append(f"{ev} active ({src}, checked {at})")
                    elif ev.endswith("Watch") or ev.endswith("Advisory"):
                        amber.append(f"{ev} active ({src}, checked {at})")
                else:
                    if RED_IPAWS.search(ev) or it.get("severity") == "Extreme":
                        red.append(f"{ev} from {it.get('sender') or 'issuing authority'} ({src}, checked {at})")
                    else:
                        amber.append(f"{ev} from {it.get('sender') or 'issuing authority'} ({src}, checked {at})")
            elif it["kind"] == "quake":
                if it.get("pager") in ("orange", "red"):
                    red.append(f"{it['title']} (USGS PAGER {it['pager']}, checked {at})")
                elif it.get("pager") == "yellow":
                    amber.append(f"{it['title']} (USGS PAGER yellow, checked {at})")
                elif it.get("recent_24h") and it.get("magnitude", 0) >= 4.5 and it.get("distance_km", 999) <= 150:
                    amber.append(f"{it['title']} in the last 24 hours ({src}, checked {at})")
            elif it["kind"] == "notice" and it.get("ops_action") and it.get("recent"):
                amber.append(f"PJM operations notice: {it['title']} ({src}, checked {at})")
            elif it["kind"] == "declaration" and it.get("active"):
                amber.append(f"Active federal declaration {it['title']} ({src}, checked {at})")
            elif it["kind"] == "forecast" and it.get("is_low"):
                t = it.get("temperature")
                if t is not None and t <= loc.forecast_low_amber_f:
                    amber.append(f"Forecast, not an event: {it['period']} low {t}°F "
                                 f"<= {loc.forecast_low_amber_f:g}°F threshold ({src}, checked {at})")

    bad = [s for s in states if s["required"] and s["state"] != "fresh"]

    if red:
        color, rule = "red", red[0]
    elif bad:
        color = "gray"
        b = bad[0]
        when = f"last good {_stamp(b['last_good_at'], loc.tz)}" if b["last_good_at"] else "no good data yet"
        rule = f"Unknown: {b['label']} is {b['state']} ({when})"
    elif amber:
        color, rule = "amber", amber[0]
    else:
        color, rule = "green", "No active NWS warnings, watches or advisories; no local or federal alerts; all required feeds fresh"

    more = len(red) + len(amber) - (1 if color in ("red", "amber") else 0)
    for s in states:
        s.pop("_data")
    return {"color": color, "rule": rule, "additional_triggers": max(more, 0),
            "triggers": {"red": red, "amber": amber}, "feeds": states,
            "computed_at": now.isoformat(timespec="seconds")}
