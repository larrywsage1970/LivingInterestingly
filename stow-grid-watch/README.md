# Stow Grid Watch

A phone-first status board for one location, built from primary sources only. Every line shows its source, the time it was fetched, and a link to the source. When a feed is down, the board says so (Gray). It never shows a stale green.

**Status: phases 1–3 + local/federal emergency feeds.** The grid (PJM, EIA), utility (FirstEnergy), reliability (NERC) and Ask cards are link-outs for now.

## Sources connected

| Feed | Source | Required for Green | Cadence |
|---|---|---|---|
| Weather alerts | NWS `api.weather.gov/alerts/active?point=` | yes | 5 min |
| Forecast (48h) | NWS `/points` → `/forecast` | yes | 30 min |
| Local / state alerts | FEMA OpenFEMA `IpawsArchivedAlerts` (county/state EMA messages sent through IPAWS; NWS ones dropped as duplicates) | no, until verified live | 10 min |
| Disaster declarations | FEMA OpenFEMA `DisasterDeclarationsSummaries` (county FIPS) | no, until verified live | 60 min |

To make a feed required, set `required=True` in `app/sources.py`.

## Banner rules (`app/status.py`)
1. **Red:** NWS *Warning*, or an IPAWS Warning, Evacuation or Shelter order, or CAP severity Extreme.
2. **Gray:** a required feed is failing, stale (older than 2x its cadence), or not yet fetched. A known Red still shows.
3. **Amber:** NWS Watch or Advisory, any other active IPAWS alert, an active FEMA declaration for the county, or a forecast low at or below `forecast_low_amber_f` (default 10°F). Forecasts are labeled "Forecast, not an event".
4. **Green:** none of the above, and all required feeds are fresh.

## Run, test, deploy
1. `cp .env.example .env` and set `SGW_USER_AGENT` with a real contact email (NWS requires one).
2. `python -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt`
3. Test: `python -m pytest -q` (offline; synthetic fixtures in `tests/fixtures`).
4. Run: `set -a; . ./.env; set +a; uvicorn app.main:app --reload`, then open http://localhost:8000
5. Build: `docker build -t stow-grid-watch .`
6. Run the container: `docker run -p 8000:8000 --env-file .env -v sgw-data:/data stow-grid-watch`
7. Deploy the container to a host that is **always on** (Azure App Service with "Always On" enabled, Fly.io, Render paid, or a VPS). Scale-to-zero hosting stops the poller. Run one instance only.
8. Point uptime monitoring at `/api/health`.
9. On iPhone: open the HTTPS URL in Safari, tap Share, then Add to Home Screen.

## Add a location
Add an object to `locations.json` (lat/lon, FIPS state + county, threshold, links). Open it with `/?location=<id>`.

## Before going live: verify
- [ ] The lat/lon for 44224 (41.1595, -81.4404) returns the right NWS forecast office (CLE).
- [ ] The NWS calls work with your User-Agent.
- [ ] The OpenFEMA IPAWS `geo.intersects(searchGeometry, …)` filter returns Summit County messages, and check how far behind real time the archive runs.
- [ ] The OpenFEMA declarations filter on `fipsStateCode`/`fipsCountyCode`.
- [ ] The URLs marked `"verified": false` in `locations.json`.
- [ ] Replace the synthetic fixtures with recorded responses.

## Layout
```
app/adapters/   one file per source; each returns {source, fetched_at, ok, items[], error?}
app/sources.py  registry: cadence, required flag
app/status.py   banner logic (pure, unit tested)
app/store.py    SQLite: every fetch kept 14 days; last-good = newest ok row
app/main.py     FastAPI: /api/health, /api/status, /api/refresh (rate-limited), static PWA
static/         plain HTML/CSS/JS PWA, no build step
```
