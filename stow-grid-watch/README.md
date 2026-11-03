# GRID

Primary-source status board. First location: Stow, OH 44224.

A phone-first status board for one location, built from primary sources only. Every line shows its source, the time it was fetched, and a link to the source. When a feed is down, the board says so (Gray). It never shows a stale green.

**Status: phases 1–3 + local/federal emergency feeds.** The grid (PJM, EIA), utility (FirstEnergy), reliability (NERC) and Ask cards are link-outs for now.

## Sources connected

| Feed | Source | Required for Green | Cadence |
|---|---|---|---|
| Weather alerts | NWS `api.weather.gov/alerts/active?point=` | yes | 5 min |
| Forecast (48h) | NWS `/points` → `/forecast` | yes | 30 min |
| Local / state alerts | FEMA OpenFEMA `IpawsArchivedAlerts` (county/state EMA messages sent through IPAWS; NWS ones dropped as duplicates). Two queries: polygon covers the point, plus records with no geometry matched on SAME code 039153/039000 or county name. | no | 10 min |
| Disaster declarations | FEMA OpenFEMA `DisasterDeclarationsSummaries` (county FIPS). Shows active declarations plus any closed in the last 2 days. | no | 60 min |

To make a feed required, set `required=True` in `app/sources.py`.

## Banner rules (`app/status.py`)
1. **Red:** NWS *Warning*, or an IPAWS Warning, Evacuation or Shelter order, or CAP severity Extreme.
2. **Gray:** a required feed is failing, stale (older than 2x its cadence), or not yet fetched. A known Red still shows.
3. **Amber:** NWS Watch or Advisory, any other active IPAWS alert, an active FEMA declaration for the county, or a forecast low at or below `forecast_low_amber_f` (default 10°F). Forecasts are labeled "Forecast, not an event".
4. **Green:** none of the above, and all required feeds are fresh.

## Deploy on GitHub Pages (current setup)
GitHub Actions runs `.github/workflows/stow-grid-watch.yml` every 15 minutes. It runs the tests, polls every source once (`python -m app.snapshot`), writes `api/status.json`, and publishes it with the PWA to Pages. There's no server and no hosting bill.

One-time setup:
1. Merge this folder and the workflow to `main`. GitHub only runs scheduled workflows from the default branch.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Optional but recommended: **Settings → Secrets and variables → Actions → Variables → New repository variable** named `SGW_USER_AGENT`, set to `GRID/0.1 (contact: you@example.com)`.
4. **Actions → GRID → Run workflow** for the first deploy.
5. Open `https://<user>.github.io/<repo>/` in Safari on the iPhone, tap Share, then Add to Home Screen.

How it behaves on Pages:
- Updates run about every 15–30 min (GitHub delays scheduled runs at busy times). Feeds count as stale after 60 min.
- Last-good values carry over between runs through the previously published snapshot.
- If the workflow stops, the phone turns the banner Gray by itself once the snapshot is older than 60 min.
- GitHub turns off scheduled workflows after 60 days with no repo activity. Re-enable from the Actions tab.
- The refresh button reloads the latest snapshot. It can't force a new poll; use **Run workflow** for that.
- The Ask feature (phase 7) needs a server or a serverless function for the API key. Pages can't hold secrets.

## Run locally or on a server
1. `cp .env.example .env` and set `SGW_USER_AGENT` with a real contact email (NWS requires one).
2. `python -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt`
3. Test: `python -m pytest -q` (offline; synthetic fixtures in `tests/fixtures`).
4. Run: `set -a; . ./.env; set +a; uvicorn app.main:app --reload`, then open http://localhost:8000. This mode polls every 5 min and has a live refresh.
5. Container: `docker build -t stow-grid-watch . && docker run -p 8000:8000 --env-file .env -v sgw-data:/data stow-grid-watch`. Use an always-on host and run one instance.

## Add a location
Add an object to `locations.json` (lat/lon, FIPS state + county, threshold, links). Open it with `/?location=<id>`.

## Before going live: verify
- [ ] The lat/lon for 44224 (41.1595, -81.4404) returns the right NWS forecast office (CLE).
- [x] The NWS calls work with the configured User-Agent (verified 2026-11-03).
- [x] OpenFEMA IPAWS query verified live 2026-11-03 (syntax is `geography'POINT(lon lat)'`, no space). The archive is current to within days. About 40% of recent records have no geometry, which the second query covers.
- [x] OpenFEMA declarations filter verified live 2026-11-03.
- [ ] The URLs marked `"verified": false` in `locations.json`.
- [ ] Replace the synthetic fixtures with recorded responses.

## Layout
```
app/adapters/   one file per source; each returns {source, fetched_at, ok, items[], error?}
app/sources.py  registry: cadence, required flag
app/status.py   banner logic (pure, unit tested)
app/store.py    SQLite: every fetch kept 14 days; last-good = newest ok row
app/main.py     FastAPI: /api/health, /api/status, /api/refresh (rate-limited), static PWA
app/snapshot.py static build for GitHub Pages (poll once, write site/ + api/status.json)
app/payload.py  status payload shared by both
static/         plain HTML/CSS/JS PWA, no build step
```
