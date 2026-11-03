"""More official .gov feeds (verified live 2026-11-03):

CISA    www.cisa.gov/cybersecurity-advisories/cybersecurity-advisories.xml
        Joint cybersecurity advisories (state-sponsored activity, ransomware, attacks on
        industrial controls). GRID keeps only the last 30 days and only those about critical
        infrastructure (energy, electric, water, industrial control, state-sponsored).
        Shown on the board; no banner color (an advisory is not a local event).

NRC     www.nrc.gov/public-involve/rss?feed=event  (title "<EN number> - <facility>")
        Filtered to nuclear plants near the location. For a match, the linked event report
        is read for its Emergency Class (NRC's own label): General Emergency / Site Area
        Emergency -> Red; Alert -> Amber; Unusual Event or non-emergency -> shown only.

AirNow  www.airnowapi.org (EPA). Needs AIRNOW_API_KEY. Current AQI by ZIP. EPA's own
        category: 4 Unhealthy / 5 Very Unhealthy -> Amber; 6 Hazardous -> Red.
"""
from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import httpx

from app.adapters.base import item, result
from app.config import Location

# ---------------- CISA ----------------
CISA_FEED = "https://www.cisa.gov/cybersecurity-advisories/cybersecurity-advisories.xml"
CISA_HOME = "https://www.cisa.gov/news-events/cybersecurity-advisories"
INFRA = re.compile(r"energy|electric|power grid|\bgrid\b|utilit|critical infrastructure|industrial control|\bICS\b|"
                   r"\bOT\b|\bPLC|SCADA|water|pipeline|state[- ]sponsored|nation[- ]state|government[- ]linked",
                   re.IGNORECASE)


def _strip(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()


def parse_cisa(xml_text: str, now: datetime, days: int = 30) -> list[dict]:
    root = ET.fromstring(xml_text)
    items = []
    for it in root.iter("item"):
        title = _strip(it.findtext("title"))
        link = (it.findtext("link") or "").strip()
        desc = _strip(it.findtext("description"))
        try:
            posted = parsedate_to_datetime(it.findtext("pubDate") or "").astimezone(timezone.utc)
        except (TypeError, ValueError):
            posted = None
        if not title or not link.startswith("https://www.cisa.gov/"):
            continue
        if posted and now - posted > timedelta(days=days):
            continue
        if not INFRA.search(title + " " + desc[:2000]):
            continue
        items.append(item("advisory", title=title, url=link, starts=posted.isoformat() if posted else None,
                          issued=posted.isoformat() if posted else None, raw_excerpt=desc[:400],
                          sender="CISA", origin="cisa"))
    items.sort(key=lambda i: i["starts"] or "", reverse=True)
    return items[:6]


async def fetch_cisa(client: httpx.AsyncClient, loc: Location) -> dict:
    r = await client.get(CISA_FEED)
    r.raise_for_status()
    return result("cisa", "CISA critical-infrastructure cyber advisories",
                  parse_cisa(r.text, datetime.now(timezone.utc)))


# ---------------- NRC ----------------
NRC_FEED = "https://www.nrc.gov/public-involve/rss?feed=event"
NRC_HOME = "https://www.nrc.gov/reading-rm/doc-collections/event-status/event/"
# Commercial nuclear plants within ~150 km of Stow, OH.
NEARBY_PLANTS = ("Perry", "Beaver Valley", "Davis-Besse", "Davis Besse")
CLASS_RE = re.compile(r"Emergency\s+Class\s*:?\s*([A-Za-z ]+?)(?:\s{2,}|\s+10\s*CFR|\s+Event|\s+Person|$)", re.I)


def parse_nrc_feed(xml_text: str) -> list[tuple[str, str, str]]:
    root = ET.fromstring(xml_text)
    out = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        m = re.match(r"(\d+)\s*-\s*(.+)", title)
        if m and link.startswith("https://www.nrc.gov/") and any(p.lower() in m.group(2).lower() for p in NEARBY_PLANTS):
            out.append((m.group(1), m.group(2).strip(), link))
    return out


def emergency_class(report_html: str, en: str) -> str | None:
    """Find the Emergency Class in the section of the daily report page for this EN number."""
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "  ", report_html))
    start = text.find(en)
    if start < 0:
        return None
    m = CLASS_RE.search(text[start:start + 6000])
    return m.group(1).strip().title() if m else None


async def fetch_nrc(client: httpx.AsyncClient, loc: Location) -> dict:
    r = await client.get(NRC_FEED)
    r.raise_for_status()
    items = []
    pages: dict[str, str] = {}
    for en, facility, link in parse_nrc_feed(r.text):
        page_url = link.split("#")[0]
        if page_url not in pages:
            p = await client.get(page_url)
            pages[page_url] = p.text if p.status_code == 200 else ""
        cls = emergency_class(pages[page_url], en)
        items.append(item("nuclear", title=f"NRC event {en}: {facility}" + (f" · {cls}" if cls else ""),
                          url=link, severity=cls, raw_excerpt=f"NRC Event Notification Report {en} for {facility}.",
                          emergency_class=cls, facility=facility, sender="U.S. NRC", origin="nrc"))
    return result("nrc", "NRC nuclear plant events (nearby)", items)


# ---------------- AirNow ----------------
AIRNOW_API = "https://www.airnowapi.org/aq/observation/zipCode/current/"
AIRNOW_HOME = "https://www.airnow.gov/"


def parse_airnow(rows: list, zip_code: str) -> list[dict]:
    items = []
    for r in rows or []:
        cat = r.get("Category") or {}
        if r.get("AQI") is None:
            continue
        hour = int(r.get("HourObserved") or 0)
        date = (r.get("DateObserved") or "").strip()
        items.append(item(
            "airquality",
            title=f"Air quality {r.get('ParameterName', '?')}: AQI {r['AQI']} · {cat.get('Name', '?')} · {r.get('ReportingArea', '')}",
            url=f"{AIRNOW_HOME}?reportingArea=&zipcode={zip_code}",
            severity=cat.get("Name"), starts=f"{date}T{hour:02d}:00" if date else None,
            raw_excerpt=f"EPA AirNow current observation ({r.get('LocalTimeZone', 'local time')}).",
            aqi=r["AQI"], aqi_category=cat.get("Number"), sender="EPA AirNow", origin="airnow",
        ))
    return items


async def fetch_airnow(client: httpx.AsyncClient, loc: Location) -> dict:
    key = os.environ.get("AIRNOW_API_KEY", "").strip()
    if not key:
        return result("airnow", "EPA AirNow air quality", error="AIRNOW_API_KEY is not set")
    zip_code = (re.search(r"\b(\d{5})\b", loc.name) or re.search(r"(\d{5})", loc.id)).group(1)
    try:
        r = await client.get(AIRNOW_API, params={"format": "application/json", "zipCode": zip_code,
                                                 "distance": "25", "API_KEY": key})
    except httpx.HTTPError as exc:
        return result("airnow", "EPA AirNow air quality", error=f"{type(exc).__name__} contacting AirNow")
    if r.status_code != 200:
        return result("airnow", "EPA AirNow air quality", error=f"AirNow HTTP {r.status_code}")   # never echo the URL (key)
    return result("airnow", "EPA AirNow air quality", parse_airnow(r.json(), zip_code))
