"""Source registry. Add a source here and it is polled, stored, shown, and checked for staleness."""
from __future__ import annotations

from app.adapters import fema, nws
from app.adapters.base import SourceSpec

SOURCES: tuple[SourceSpec, ...] = (
    SourceSpec("nws_alerts", "NWS alerts", cadence_s=300, required=True,
               fetch=nws.fetch_alerts, home_url=nws.alerts_home),
    SourceSpec("nws_forecast", "NWS forecast", cadence_s=1800, required=True,
               fetch=nws.fetch_forecast, home_url=nws.alerts_home),
    # Not required until verified live (see app/adapters/fema.py).
    SourceSpec("fema_ipaws", "IPAWS local/state alerts", cadence_s=600, required=False,
               fetch=fema.fetch_ipaws,
               home_url=lambda loc: "https://www.fema.gov/about/openfema/data-sets#integrated"),
    SourceSpec("fema_declarations", "FEMA disaster declarations", cadence_s=3600, required=False,
               fetch=fema.fetch_declarations,
               home_url=lambda loc: "https://www.fema.gov/disaster/declarations"),
)

BY_ID = {s.id: s for s in SOURCES}
