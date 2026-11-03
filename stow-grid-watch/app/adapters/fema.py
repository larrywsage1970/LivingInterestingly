"""FEMA OpenFEMA API (www.fema.gov/api/open). Free, no key.

Two datasets:
  DisasterDeclarationsSummaries v2  federal declarations, filtered to the county FIPS
  IpawsArchivedAlerts v1            alerts sent through IPAWS by any authority,
                                    including county/state EMAs. This is the
                                    machine-readable path to LOCAL emergency alerts.
NWS-originated IPAWS messages are dropped here because the NWS adapter covers them.

Query syntax verified against the live API on 2026-11-03 (via a GitHub Actions probe).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx

from app.adapters.base import item, result
from app.config import Location

OPENFEMA = "https://www.fema.gov/api/open"
NWS_SENDER = "w-nws.webmaster@noaa.gov"   # NWS alerts come from the NWS adapter instead


def _dt(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------- disaster declarations ----------

def parse_declarations(payload: dict, now: datetime) -> list[dict]:
    items = []
    for d in payload.get("DisasterDeclarationsSummaries", []):
        end = _dt(d.get("incidentEndDate"))
        active = end is None or end >= now
        num = d.get("disasterNumber")
        items.append(item(
            "declaration",
            title=f"{d.get('declarationType', '')}-{num}: {d.get('declarationTitle', '')} ({d.get('incidentType', '')})",
            url=f"https://www.fema.gov/disaster/{num}",
            starts=d.get("incidentBeginDate"),
            ends=d.get("incidentEndDate"),
            raw_excerpt=d.get("designatedArea") or "",
            declared=d.get("declarationDate"),
            incident_type=d.get("incidentType"),
            declaration_type=d.get("declarationType"),
            active=active,
        ))
    return items


async def fetch_declarations(client: httpx.AsyncClient, loc: Location) -> dict:
    params = {
        "$filter": f"fipsStateCode eq '{loc.fips_state}' and fipsCountyCode eq '{loc.fips_county}'",
        "$orderby": "declarationDate desc",
        "$top": "10",
    }
    r = await client.get(f"{OPENFEMA}/v2/DisasterDeclarationsSummaries", params=params)
    r.raise_for_status()
    items = parse_declarations(r.json(), datetime.now(timezone.utc))
    return result("fema_declarations", "FEMA disaster declarations", items)


# ---------- IPAWS (local + state + federal alerts) ----------

def _is_nws(sender: str | None) -> bool:
    s = (sender or "").lower()
    return "nws" in s or "noaa" in s


def parse_ipaws(payload: dict, now: datetime) -> list[dict]:
    items = []
    for a in payload.get("IpawsArchivedAlerts", []):
        if a.get("status") != "Actual" or a.get("msgType") == "Cancel":
            continue
        if _is_nws(a.get("sender")):
            continue
        infos = a.get("info") or [{}]
        info = next((i for i in infos if str(i.get("language", "")).lower().startswith("en")), infos[0])
        expires = _dt(info.get("expires"))
        if expires and expires < now:
            continue
        ident = a.get("identifier", "")
        # OpenFEMA names the CAP <area> list "areas"; accept "area" too.
        area_list = info.get("areas") or info.get("area") or []
        areas = "; ".join(x.get("areaDesc", "") for x in area_list if isinstance(x, dict) and x.get("areaDesc"))
        items.append(item(
            "alert",
            title=info.get("headline") or info.get("event") or "IPAWS alert",
            url=f"{OPENFEMA}/v1/IpawsArchivedAlerts?$filter=identifier eq '{ident}'",
            severity=info.get("severity"),
            starts=info.get("onset") or info.get("effective") or a.get("sent"),
            ends=info.get("expires"),
            raw_excerpt=(info.get("description") or "") + (f" Area: {areas}" if areas else ""),
            event=info.get("event"),
            sender=info.get("senderName") or a.get("sender"),
            urgency=info.get("urgency"),
            certainty=info.get("certainty"),
            issued=a.get("sent"),
            origin="ipaws",
        ))
    return items


def _matches_county(rec: dict, loc: Location) -> bool:
    """For records with no geometry: match the county or statewide SAME code, or the county name."""
    county_same = f"0{loc.fips_state}{loc.fips_county}"   # e.g. 039153
    state_same = f"0{loc.fips_state}000"                  # statewide, e.g. 039000
    text = rec.get("originalMessage") or ""
    if county_same in text or state_same in text:
        return True
    county_word = loc.county.split()[0]                    # "Summit"
    for info in rec.get("info") or []:
        for area in (info.get("areas") or info.get("area") or []):
            desc = (area or {}).get("areaDesc", "") if isinstance(area, dict) else ""
            if county_word in desc and (loc.state in desc or "Ohio" in desc):
                return True
    return False


async def fetch_ipaws(client: httpx.AsyncClient, loc: Location) -> dict:
    since = (datetime.now(timezone.utc) - timedelta(hours=72)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    base = f"sent ge '{since}' and sender ne '{NWS_SENDER}'"
    # 1) Alerts whose polygon covers the point.
    #    Verified live 2026-11-03: OpenFEMA rejects a space between geography and the quote.
    geo = await client.get(f"{OPENFEMA}/v1/IpawsArchivedAlerts", params={
        "$filter": f"{base} and geo.intersects(searchGeometry, geography'POINT({loc.lon} {loc.lat})')",
        "$orderby": "sent desc", "$top": "100"})
    geo.raise_for_status()
    # 2) About 40% of recent records carry no geometry, so the polygon filter can't see them.
    #    Pull those (small volume) and match on county/state SAME code or county name.
    nogeo = await client.get(f"{OPENFEMA}/v1/IpawsArchivedAlerts", params={
        "$filter": f"{base} and searchGeometry eq null and msgType ne 'Cancel'",
        "$orderby": "sent desc", "$top": "1000"})
    nogeo.raise_for_status()

    records, seen = [], set()
    for rec in geo.json().get("IpawsArchivedAlerts", []) + [
            r for r in nogeo.json().get("IpawsArchivedAlerts", []) if _matches_county(r, loc)]:
        if rec.get("identifier") not in seen:
            seen.add(rec.get("identifier"))
            records.append(rec)
    items = parse_ipaws({"IpawsArchivedAlerts": records}, datetime.now(timezone.utc))
    return result("fema_ipaws", "IPAWS local/state alerts", items)
