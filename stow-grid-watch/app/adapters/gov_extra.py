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

AirNow  files.airnowtech.org public hourly file (no key; the old API was retired 2026-10-01).
        Nearest reporting area. EPA category: 4 Unhealthy / 5 Very Unhealthy -> Amber; 6 Hazardous -> Red.

CDC     U.S. outbreak notices RSS (tools.cdc.gov). Last 60 days. Shown only.
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
                          issued=posted.isoformat() if posted else None, raw_excerpt=desc[:3000],
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


def report_section(report_html: str, en: str) -> str:
    """Plain text of this EN number's section of the daily report page."""
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "  ", report_html))
    start = text.find(en)
    return text[start:start + 6000] if start >= 0 else ""


def emergency_class(report_html: str, en: str) -> str | None:
    """Find the Emergency Class in the section of the daily report page for this EN number."""
    m = CLASS_RE.search(report_section(report_html, en))
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
                          url=link, severity=cls,
                          raw_excerpt=re.sub(r"\s+", " ", report_section(pages[page_url], en))[:3000]
                          or f"NRC Event Notification Report {en} for {facility}.",
                          emergency_class=cls, facility=facility, sender="U.S. NRC", origin="nrc"))
    return result("nrc", "NRC nuclear plant events (nearby)", items)


# ---------------- AirNow ----------------
# The AirNow web-service API was retired Oct 1, 2026 (it now returns 410). AirNow's public
# hourly file product needs no key: one pipe-delimited row per reporting area / pollutant.
# Columns: IssueDate|ValidDate|ValidTime|TimeZone|HourOffset|DataType(O=observed, F=forecast,
#          Y=yesterday)|Primary|ReportingArea|State|Lat|Lon|Parameter|AQI|Category|ActionDay|Discussion|Source
AIRNOW_FILE = "https://files.airnowtech.org/airnow/today/reportingarea.dat"
AIRNOW_HOME = "https://www.airnow.gov/"
AQI_CATEGORY = {"good": 1, "moderate": 2, "unhealthy for sensitive groups": 3, "unhealthy": 4,
                "very unhealthy": 5, "hazardous": 6}


def _km(lat1, lon1, lat2, lon2) -> float:
    import math
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 6371 * 2 * math.asin(math.sqrt(a))


def parse_airnow_file(text: str, loc: Location, max_km: float = 60) -> list[dict]:
    rows = []
    for line in text.splitlines():
        f = line.split("|")
        if len(f) < 15:
            continue
        try:
            lat, lon = float(f[9]), float(f[10])
        except ValueError:
            continue
        rows.append({"valid_date": f[1], "valid_time": f[2], "tz": f[3], "type": f[5], "primary": f[6] == "Y",
                     "area": f[7], "state": f[8], "lat": lat, "lon": lon, "param": f[11],
                     "aqi": int(f[12]) if f[12].strip().isdigit() else None, "category": f[13].strip(),
                     "action_day": f[14].strip().lower() == "yes", "source": f[16].strip() if len(f) > 16 else "",
                     "km": _km(loc.lat, loc.lon, lat, lon)})
    near = [r for r in rows if r["km"] <= max_km and r["type"] in ("O", "F")]
    if not near:
        return []
    area = min(near, key=lambda r: r["km"])["area"]
    mine = [r for r in near if r["area"] == area]
    items = []
    obs = [r for r in mine if r["type"] == "O" and r["aqi"] is not None]
    if obs:
        worst = max(obs, key=lambda r: (AQI_CATEGORY.get(r["category"].lower(), 0), r["aqi"]))
        items.append(item(
            "airquality",
            title=f"Air quality now: AQI {worst['aqi']} {worst['category']} ({worst['param']}) · {area}, {worst['state']} · {round(worst['km'])} km away",
            url=AIRNOW_HOME, severity=worst["category"],
            starts=None, issued=None,
            raw_excerpt=f"EPA AirNow observation for {area}, {worst['valid_date']} {worst['valid_time']} {worst['tz']}. "
                        f"Reported by {worst['source'] or 'the local air agency'}.",
            aqi=worst["aqi"], aqi_category=AQI_CATEGORY.get(worst["category"].lower()), sender="EPA AirNow",
            origin="airnow", observed=True,
        ))
    fc = [r for r in mine if r["type"] == "F" and r["primary"]]
    if fc:
        today = min(fc, key=lambda r: r["valid_date"])
        cat = AQI_CATEGORY.get(today["category"].lower())
        if cat and (cat >= 3 or today["action_day"]):
            items.append(item(
                "forecast",
                title=f"Air quality forecast {today['valid_date']}: {today['category']} ({today['param']})"
                      + (" · Air Quality Action Day" if today["action_day"] else ""),
                url=AIRNOW_HOME, raw_excerpt=f"EPA AirNow forecast for {area}.", sender="EPA AirNow",
                hazard_mentions=["air quality"], aqi_category=cat,
            ))
    return items


async def fetch_airnow(client: httpx.AsyncClient, loc: Location) -> dict:
    r = await client.get(AIRNOW_FILE)
    r.raise_for_status()
    return result("airnow", "EPA AirNow air quality", parse_airnow_file(r.text, loc))


# ---------------- CDC ----------------
# CDC's syndicated RSS of U.S.-based outbreak notices (verified current 2026-11-03).
# CDC Health Alert Network has no current machine-readable feed (its archive data file is a
# stale snapshot), so HAN stays a link.
CDC_OUTBREAKS = "https://tools.cdc.gov/api/v2/resources/media/285676.rss"
CDC_HOME = "https://www.cdc.gov/outbreaks/"


def parse_cdc(xml_text: str, now: datetime, days: int = 60) -> list[dict]:
    root = ET.fromstring(xml_text)
    items = []
    for it in root.iter("item"):
        title = _strip(it.findtext("title"))
        link = (it.findtext("link") or "").strip()
        try:
            posted = parsedate_to_datetime(it.findtext("pubDate") or "").astimezone(timezone.utc)
        except (TypeError, ValueError):
            continue
        host = re.match(r"https?://([^/]+)/", link + "/")
        if not title or not host or not (host.group(1) == "cdc.gov" or host.group(1).endswith(".cdc.gov")):
            continue
        link = "https://" + link.split("://", 1)[1]                   # always https
        if now - posted > timedelta(days=days):
            continue
        items.append(item("health", title=title, url=link, starts=posted.isoformat(), issued=posted.isoformat(),
                          raw_excerpt=_strip(it.findtext("description"))[:3000], sender="CDC", origin="cdc"))
    items.sort(key=lambda i: i["starts"], reverse=True)
    return items[:6]


async def fetch_cdc(client: httpx.AsyncClient, loc: Location) -> dict:
    r = await client.get(CDC_OUTBREAKS)
    r.raise_for_status()
    return result("cdc", "CDC U.S. outbreak notices", parse_cdc(r.text, datetime.now(timezone.utc)))
