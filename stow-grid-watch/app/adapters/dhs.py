"""DHS National Terrorism Advisory System (NTAS): national security / terrorism advisories.

Feed: https://www.dhs.gov/ntas/1.1/alerts.xml (official DHS XML feed). An empty <alerts/>
means "There are no current advisories" (verified live 2026-11-03 against the DHS page).

NTAS has three advisory types, copied from the source (never invented):
  Bulletin                broad national threat information          -> shown, no banner color
  Elevated Threat Alert   credible threat against the United States  -> Amber
  Imminent Threat Alert   credible, specific, impending threat       -> Red
The XML shape for a non-empty feed follows the DHS NTAS 1.1 format; parsing is tolerant of
attribute vs. child-element placement because no live advisory was available to record.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx

from app.adapters.base import item, result
from app.config import Location

FEED = "https://www.dhs.gov/ntas/1.1/alerts.xml"
HOME = "https://www.dhs.gov/national-terrorism-advisory-system"
ET_ZONE = ZoneInfo("America/New_York")   # NTAS dates are Eastern Time


def _field(el, *names) -> str:
    for n in names:
        if el.get(n):
            return el.get(n).strip()
        child = el.find(n)
        if child is not None and (child.text or "").strip():
            return child.text.strip()
    return ""


def _when(s: str) -> str | None:
    s = s.strip()
    if not s:
        return None
    for fmt in ("%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M", "%Y/%m/%d %I:%M %p", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=ET_ZONE).isoformat()
        except ValueError:
            continue
    try:
        d = datetime.fromisoformat(s)
        return (d if d.tzinfo else d.replace(tzinfo=ET_ZONE)).isoformat()
    except ValueError:
        return None


def parse(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    items = []
    for a in root.iter("alert"):
        kind = _field(a, "type") or "Advisory"
        summary = re.sub(r"\s+", " ", _field(a, "summary", "details"))
        link = _field(a, "link", "href")
        if not link.startswith("https://www.dhs.gov/"):
            link = HOME
        items.append(item(
            "alert",
            title=f"NTAS {kind}" + (f": {summary[:140]}" if summary else ""),
            url=link,
            starts=_when(_field(a, "start")),
            ends=_when(_field(a, "end")),
            raw_excerpt=summary,
            event=f"NTAS {kind}",
            ntas_type=kind,
            sender="DHS National Terrorism Advisory System",
            origin="ntas",
        ))
    return items


async def fetch(client: httpx.AsyncClient, loc: Location) -> dict:
    r = await client.get(FEED, headers={"Accept": "application/xml, application/rss+xml"})
    r.raise_for_status()
    return result("dhs_ntas", "DHS terrorism advisories (NTAS)", parse(r.text))
