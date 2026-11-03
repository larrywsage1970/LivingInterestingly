"""Source registry. Add a source here and it is polled, stored, shown, and checked for staleness."""
from __future__ import annotations

import os
from dataclasses import replace

from app.adapters import dhs, fema, nws, pjm, usgs
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
    # PJM's own operations news (RSS). Optional: a news outage should not gray the banner.
    SourceSpec("pjm_insidelines", "PJM Inside Lines · Operations", cadence_s=1800, required=False,
               fetch=pjm.fetch, home_url=lambda loc: pjm.HOME),
)

# Static (GitHub Pages) mode polls on a slower, irregular schedule. Raising the floor
# keeps the 2x-cadence staleness rule honest about that instead of flapping to Gray.
_MIN = int(os.environ.get("SGW_MIN_CADENCE_S", "0"))
if _MIN:
    SOURCES = tuple(replace(s, cadence_s=max(s.cadence_s, _MIN)) for s in SOURCES)

BY_ID = {s.id: s for s in SOURCES}
