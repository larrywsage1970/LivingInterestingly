# Identity Watch

Personal exposure monitor on Cloudflare Workers + D1. Checks Have I Been Pwned weekly; every quarter it also sweeps the web (Brave Search), optionally a leak index (Intelligence X), and walks the data broker checklist. Emails one short report with **only what is new**.

> Keep this repo **private**. The code holds no personal data (identifiers, keys, and findings live in Worker secrets and D1), but config such as `IGNORE_DOMAINS` and `REQUEST_FROM` can reveal your domains. Never commit `.dev.vars`, real identifiers, or report output. (`.gitignore` covers `.dev.vars`.)

## What runs when

| Cron (UTC) | Kind | Sources |
|---|---|---|
| `0 13 * * 1` (Mon 13:00) | weekly | HIBP |
| `0 13 1 */3 *` (Jan/Apr/Jul/Oct 1st) | quarterly | HIBP + web sweep + leak index (if on) + broker re-checks |
| `POST /run` (dashboard button) | manual | same as quarterly |

Every run emails you, `Identity Watch: N new findings` or `Identity Watch: all clear`, with sections for new breaches, leak hits, web mentions, brokers due, and errors. A web result on a known broker domain auto-marks that broker as **listed**.

## Setup (about 20 minutes)

All commands run from this folder: `cd identity-watch && npm install`.

1. **Log in:** `npx wrangler login`
2. **Create D1** and paste the `database_id` it prints into `wrangler.toml`:
   `npx wrangler d1 create identity_watch`
3. **Apply the schema** (both migrations): `npx wrangler d1 migrations apply identity_watch --remote`
4. **Get keys:**
   - HIBP: haveibeenpwned.com/API/Key (paid; the lowest tier is fine at the default 6.5 s gap).
   - Brave Search API: api-dashboard.search.brave.com (free tier is enough: about 8 queries per quarter).
   - Resend: resend.com. Until you verify a domain, the sender `onboarding@resend.dev` can only email **your own Resend account address**, so make that `REPORT_TO`, or verify a domain and set `REPORT_FROM` in `wrangler.toml`.
5. **Set secrets** (each command prompts for the value; nothing lands in git or shell history):
   ```
   npx wrangler secret put IDENTIFIERS_JSON
   npx wrangler secret put HIBP_API_KEY
   npx wrangler secret put BRAVE_API_KEY
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put REPORT_TO
   ```
   `IDENTIFIERS_JSON` format, on one line:
   `{"emails":["you@example.com"],"names":["First Last","First M Last"],"city":"City, ST","phones":[]}`
   Only `emails`, `names`, `city`, and `phones` are accepted. The Worker refuses to run if it sees an SSN-like or card/account-like number, or any other field.
6. **Deploy:** `npx wrangler deploy`
7. **First test run** (pick one):
   - With the dashboard set up (below): click **Run full scan now**, then click it again. The second email must say **all clear**.
   - Without it: temporarily add `"*/10 * * * *"` to `crons` in `wrangler.toml`, deploy, wait for two emails (the second must say **all clear**), then remove that line and deploy again.

## Dashboard (Phase 3, optional)

The Worker ships with `workers_dev = false` and refuses every HTTP request unless it carries a valid Cloudflare Access token for **this** application. With no Access settings it returns 404 for everything.

1. Zero Trust → Access → Applications → Add → Self-hosted. Give it a hostname (a route on your domain, or the `identity-watch.<you>.workers.dev` hostname if you set `workers_dev = true`). Policy: Allow → Emails → just you.
2. Copy the application's **AUD tag**. Your team domain is `<team>.cloudflareaccess.com`.
3. Set them in `wrangler.toml` `[vars]`: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and optionally `DASHBOARD_URL` (adds a link to each email). Redeploy.

The dashboard lists open findings (set new / reviewed / actioned / dismissed), the broker checklist (listed status, opt-out submitted date, URL, notes), and recent runs. Entering an opt-out date schedules a re-check `BROKER_RECHECK_DAYS` (default 90) later. POSTs must be same-origin.

## Removing things

**Records in the dashboard**
- **Dismiss** a finding: it stays in the database and never alerts again.
- **Delete** a finding: it is forgotten. If it is still online, the next scan reports it as new. "Delete all dismissed" clears them in bulk.
- **Remove** a broker: it disappears from your list and reports. It is kept as a hidden row so the seed list never re-adds it, and **Restore** brings it back. **Add broker** puts any other site on the checklist.

**Your information on other sites** (you review everything; nothing is sent by the cron)
- **Google first.** The dashboard links Google's *Results about you* (removes search results showing your phone, address, or email, and alerts you to new ones) and *Remove outdated content* (for pages already taken down).
- **Brokers with a privacy email** (seeded: MyLife, Whitepages; add others in the row): **Email request** opens a pre-filled deletion and opt-out letter with your names, city, reply address, and any profile URLs the web sweep found on that broker. Edit it, then **Send request**. It is sent from `REQUEST_FROM`, with reply-to and BCC set to you. It is logged, the broker is marked submitted, and it comes due again in `BROKER_RECHECK_DAYS`.
- **Form-only brokers** (most of them): **Open form**, complete it yourself (they use captchas and email verification, which this tool will not automate), then **Submitted form today** to log it and schedule the re-check.
- **Other websites** (non-broker web findings): **Request removal** drafts a letter to the site. You enter the site's contact address. The finding is marked actioned, and the follow-up appears in your weekly email after `REQUEST_RECHECK_DAYS` (45). Mark each request **Gone: confirm** or **Still there**.

The letter includes only what a site needs to find you: no phone, date of birth, or ID numbers. The sender refuses a draft containing an SSN-like number or an unfilled profile-URL placeholder.

**To turn on email requests:** in Resend, add and verify a domain you own (DNS records at your registrar; takes about 10 minutes). Then set `REQUEST_FROM = "Your Name <privacy@yourdomain.com>"` in `wrangler.toml`, and optionally `wrangler secret put REQUEST_REPLY_TO` (defaults to `REPORT_TO`). Deploy, then run `npx wrangler d1 migrations apply identity_watch --remote` for migration 0002. Replies to these requests go to your inbox, not the tool.

## Leak index (off by default)

Set `LEAKINDEX_ENABLED = "true"` in `wrangler.toml` and `npx wrangler secret put INTELX_API_KEY`. Free Intelligence X keys need `INTELX_BASE_URL = "https://free.intelx.io"` in `[vars]`. Only the leak's name, bucket, and date are stored; file contents are never fetched. *Built to the Intelligence X API docs and tested with mocks only. Watch the first real run's Errors section.*

## Broker list

16 brokers are seeded on the first quarterly or manual run (insert-only, so your edits are never overwritten; a blank privacy email is filled in if the seed has one). Opt-out URLs were cross-checked against several 2025–26 privacy guides on 2026-11-05, but the broker sites could not be opened from the build environment, so each one is marked **unverified** in its notes. FastPeopleSearch, MyLife, PeopleFinders, and ThatsThem have no URL because the guides disagree or give none; their notes say where to look. The MyLife and Whitepages privacy emails also come from guides and are unverified. Fix URLs in the dashboard as you confirm them.

Intelius, Instant Checkmate, and US Search all use the PeopleConnect Suppression Center: one request covers all three.

## Manual items this tool can't do

- Credit freezes: Equifax, Experian, TransUnion (also consider ChexSystems and NCTUE).
- IRS Identity Protection PIN: irs.gov/ippin.
- Broker opt-outs themselves (the tool tracks them and reminds you).

## Develop and test

```
npm test              # unit + end-to-end tests on an in-memory D1 (node:sqlite), all network mocked
npm run typecheck
npm run db:migrate:local
npm run dev           # wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+13+*+*+1"      # weekly
curl "http://localhost:8787/__scheduled?cron=0+13+1+*/3+*"    # quarterly
```

For local runs, put fake values in `.dev.vars` (git-ignored). `DRY_RUN=true` prints the report instead of emailing. `HIBP_BASE_URL`, `BRAVE_BASE_URL`, `RESEND_BASE_URL`, and `INTELX_BASE_URL` can point at a local mock server.

## Security rules (enforced in code where possible)

- No identifiers, keys, or findings in git. Secrets only via `wrangler secret put`.
- Logs carry counts only; error messages mask identifiers (`t***@example.com`).
- Findings store breach names, data-class labels, URLs, and leak names only. Never passwords, hashes, or records.
- Every HTTP route sits behind Cloudflare Access, with the JWT verified in the Worker (fail closed).
- `IDENTIFIERS_JSON` rejects SSN-like and card/account-like numbers and unknown fields.

## Layout

```
src/index.ts         scheduled() + fetch() (export nothing else: workerd treats named exports as handlers)
src/schedule.ts      cron -> run kind
src/scan.ts          one run: sources -> diff -> report -> email -> runs row
src/config.ts        env, identifier validation, helpers
src/sources/hibp.ts  HIBP v3, 429 backoff
src/sources/websearch.ts  Brave Search, ignore list, URL normalization
src/sources/leakindex.ts  Intelligence X (flagged)
src/diff.ts          sha256 fingerprints, INSERT OR IGNORE ... RETURNING
src/brokers.ts       seed list, due logic, auto-flag from web hits
src/report.ts / mail.ts   email body, Resend
src/access.ts        Cloudflare Access JWT verification
src/dashboard.ts     /dashboard and its forms (delete/restore, add broker, request drafts)
src/removal.ts       removal letter, send + log, follow-up due logic
migrations/0001_init.sql, 0002_removal.sql
```
