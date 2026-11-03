"""Source registry. Add a source here and it is polled, stored, shown, and checked for staleness."""
from __future__ import annotations

import os
from dataclasses import replace

from app.adapters import dhs, fema, gov_extra, noaa, nws, usgs
from app.adapters.base import SourceSpec

SOURCES: tuple[SourceSpec, ...] = (
    SourceSpec("nws_alerts", "NWS alerts", cadence_s=300, required=True,
               fetch=nws.fetch_alerts, home_url=nws.alerts_home),
    SourceSpec("nws_forecast", "NWS forecast", cadence_s=1800, required=True,
               fetch=nws.fetch_forecast, home_url=nws.alerts_home),
    # Required: an IPAWS outage turns the banner Gray instead of a possibly wrong Green.
    SourceSpec("fema_ipaws", "IPAWS local/state alerts", cadence_s=600, required=True,
               fetch=fema.fetch_ipaws,
               home_url=lambda loc: "https://www.fema.gov/about/openfema/data-sets#integrated"),
    SourceSpec("fema_declarations", "FEMA disaster declarations", cadence_s=3600, required=False,
               fetch=fema.fetch_declarations,
               home_url=lambda loc: "https://www.fema.gov/disaster/declarations"),
    # National security / terrorism advisories. Optional: national scope, changes rarely.
    SourceSpec("dhs_ntas", "DHS terrorism advisories (NTAS)", cadence_s=1800, required=False,
               fetch=dhs.fetch, home_url=lambda loc: dhs.HOME),
    # Earthquakes near the location. Optional.
    SourceSpec("usgs_quakes", "USGS earthquakes (300 km, 7 days)", cadence_s=1800, required=False,
               fetch=usgs.fetch, home_url=lambda loc: usgs.HOME),
    # FEMA declarations anywhere in the U.S., last 7 days. Context only.
    SourceSpec("fema_national", "FEMA declarations nationwide (7 days)", cadence_s=3600, required=False,
               fetch=fema.fetch_national, home_url=lambda loc: "https://www.fema.gov/disaster/declarations"),
    # NOAA space weather: geomagnetic storms that can affect the power grid.
    SourceSpec("noaa_swpc", "NOAA space weather (grid storms)", cadence_s=1800, required=False,
               fetch=noaa.fetch_swpc, home_url=lambda loc: noaa.SWPC_HOME),
    # NOAA Storm Prediction Center: severe storm / tornado outlook, days 1-3.
    SourceSpec("noaa_spc", "NOAA severe storm & tornado outlook", cadence_s=1800, required=False,
               fetch=noaa.fetch_spc, home_url=lambda loc: noaa.SPC_HOME),
    # CISA critical-infrastructure cyber advisories (filtered).
    SourceSpec("cisa", "CISA critical-infrastructure cyber advisories", cadence_s=3600, required=False,
               fetch=gov_extra.fetch_cisa, home_url=lambda loc: gov_extra.CISA_HOME),
    # NRC event reports for nearby nuclear plants.
    SourceSpec("nrc", "NRC nuclear plant events (nearby)", cadence_s=1800, required=False,
               fetch=gov_extra.fetch_nrc, home_url=lambda loc: gov_extra.NRC_HOME),
    # EPA AirNow air quality (public hourly file, no key).
    SourceSpec("airnow", "EPA AirNow air quality", cadence_s=1800, required=False,
               fetch=gov_extra.fetch_airnow, home_url=lambda loc: gov_extra.AIRNOW_HOME),
    # CDC U.S. outbreak notices.
    SourceSpec("cdc", "CDC U.S. outbreak notices", cadence_s=3600, required=False,
               fetch=gov_extra.fetch_cdc, home_url=lambda loc: gov_extra.CDC_HOME),
)

# Static (GitHub Pages) mode polls on a slower, irregular schedule. Raising the floor
# keeps the 2x-cadence staleness rule honest about that instead of flapping to Gray.
_MIN = int(os.environ.get("SGW_MIN_CADENCE_S", "0"))
if _MIN:
    SOURCES = tuple(replace(s, cadence_s=max(s.cadence_s, _MIN)) for s in SOURCES)

BY_ID = {s.id: s for s in SOURCES}
