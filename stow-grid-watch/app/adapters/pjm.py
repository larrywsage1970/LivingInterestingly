"""PJM Inside Lines: PJM's own news site, Operations category RSS (public; robots.txt allows /feed/).

This is PJM announcing operations actions in plain language ("Operations Update: PJM Issues
Cold Weather Alert for ..."). It is NOT the real-time Emergency Procedures system, which
needs a PJM Tools account. Posts are kind "notice"; only posts from the last 48h whose title
names an alert/advisory/emergency action AND says PJM is issuing/extending/declaring it (or is an
"Operations Update") count toward the banner (Amber, never Red). Retrospectives do not.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import httpx

from app.adapters.base import item, result
from app.config import Location

FEED = "https://insidelines.pjm.com/category/operations/feed/"
HOME = "https://insidelines.pjm.com/category/operations/"
RECENT = timedelta(hours=48)
OPS_ACTION = re.compile(
    r"(hot|cold) weather alert|maximum generation|max gen|load management|capacity advisory|"
    r"conservative operations|emergency|voltage reduction|load shed", re.IGNORECASE)
# PJM taking or extending an action now, not reviewing one afterward ("PJM Reviews ...").
ACTION_VERB = re.compile(r"\b(issues?|issued|extends?|extended|calls? on|declares?|declared|initiates?|"
                         r"initiated|activates?|activated)\b", re.IGNORECASE)


def _text(el, tag: str) -> str:
    found = el.find(tag)
    return (found.text or "").strip() if found is not None and found.text else ""


def parse(xml_text: str, now: datetime, limit: int = 8) -> list[dict]:
    root = ET.fromstring(xml_text)
    items = []
    for it in root.iter("item"):
        title = _text(it, "title")
        link = _text(it, "link")
        if not title or not link.startswith("https://insidelines.pjm.com/"):
            continue
        try:
            posted = parsedate_to_datetime(_text(it, "pubDate")).astimezone(timezone.utc)
        except (TypeError, ValueError):
            continue
        cats = [c.text.strip() for c in it.findall("category") if c.text]
        desc = re.sub(r"<[^>]+>", " ", _text(it, "description"))
        names_action = bool(OPS_ACTION.search(title)) and (
            title.lower().startswith("operations update") or bool(ACTION_VERB.search(title)))
        items.append(item(
            "notice",
            title=title,
            url=link,
            starts=posted.isoformat(),
            raw_excerpt=re.sub(r"\s+", " ", desc).strip(),
            issued=posted.isoformat(),
            sender="PJM Inside Lines",
            categories=cats[:8],
            ops_action=names_action,
            recent=(now - posted) <= RECENT,
        ))
    items.sort(key=lambda i: i["starts"], reverse=True)
    return items[:limit]


async def fetch(client: httpx.AsyncClient, loc: Location) -> dict:
    r = await client.get(FEED, headers={"Accept": "application/rss+xml, application/xml"})
    r.raise_for_status()
    return result("pjm_insidelines", "PJM Inside Lines · Operations",
                  parse(r.text, datetime.now(timezone.utc)))
