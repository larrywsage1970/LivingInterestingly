# Spec addendum: local and federal emergency data

Give this to both builds (Claude Code and Codex) so the comparison uses the same input.

## New sources
| Layer | Source | Access | Cadence | Banner effect |
|---|---|---|---|---|
| Local, state and federal alerts | FEMA OpenFEMA `IpawsArchivedAlerts` v1. Filter: `sent ge '<now-72h>' and geo.intersects(searchGeometry, geography 'POINT(lon lat)')` | Free, no key | 10 min | Warning, Evacuation, Shelter, or CAP severity Extreme → Red. Any other active alert → Amber. |
| Federal declarations | FEMA OpenFEMA `DisasterDeclarationsSummaries` v2. Filter: `fipsStateCode eq '39' and fipsCountyCode eq '153'` | Free, no key | 60 min | Active (no `incidentEndDate`, or one in the future) → Amber |
| Link-outs | Ohio EMA, Summit County EMA, FEMA Ohio page | Static | n/a | None |

## Rules
- Drop IPAWS messages sent by NWS (the NWS adapter already covers them). Drop `status != Actual` and `msgType == Cancel`.
- Optional (not required for Green) until verified live. A failing optional feed shows "unavailable" on its card but does not turn the banner Gray.
- Precedence: Red, then Gray, then Amber, then Green. Known Red is never hidden by Gray.

## Comparison checklist (score each build)
1. Do all tests pass, and do they cover the four banner states plus stale and failing feeds?
2. Does any path show Green while a required feed is failing? (Must be no.)
3. Does every item on screen carry a source, a timestamp and a link?
4. How many files and dependencies are there, and how long does it take to read status.py end to end?
5. How long from `git clone` to running on a phone?
6. How does it fail when the network is down (server side, and with the phone offline)?
