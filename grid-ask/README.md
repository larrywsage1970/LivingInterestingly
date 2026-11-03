# GRID Ask (Cloudflare Worker)

Answers questions on the GRID board using **only** primary sources. Claude can call two tools:

- `get_current_status`: GRID's published snapshot (the same data the board shows).
- `fetch_primary_source(url)`: a GET to an allowlisted domain (NWS, FEMA, ready.gov, Ohio EMA, PJM, NERC, EIA, DOE, FirstEnergy).

The allowlist is enforced in code on every request and redirect. Answers cite each source and time, stay under about 170 words, and say so when the sources don't answer the question. Each answer's sources are logged (Workers Logs). The user's IP is not logged.

Same deploy pattern as `youtube-transcript`: Cloudflare Git integration plus Secrets Store.

## One-time setup (about 15 minutes)
1. **Anthropic API key:** at console.anthropic.com, create a key. Under **Billing → Limits**, set a monthly spend limit, for example $10.
2. **Secrets Store** (Cloudflare dashboard → Workers & Pages → Secrets Store → Create secret). The store ID in `wrangler.toml` is the same one `youtube-transcript` uses:
   - `ANTHROPIC_API_KEY`: the key from step 1.
   - `GRID_ASK_PASSCODE`: a passcode you choose and share only with people you want using Ask.
3. **Create the Worker from Git:** Workers & Pages → Create → Import a repository → `LivingInterestingly`. Set the **root directory to `grid-ask`** and the deploy branch to `main`. Cloudflare installs the SDK from `package.json` during the build.
4. Note the Worker URL, for example `https://grid-ask.<your-subdomain>.workers.dev`, and check `…/health` returns `{"ok":true}`.
5. **Turn on the Ask card:** in GitHub, go to Settings → Secrets and variables → Actions → **Variables** → New, and add `SGW_ASK_URL` with the Worker URL. The next GRID update shows the Ask card.

## Config
| Name | Where | Purpose |
|---|---|---|
| `ANTHROPIC_MODEL` | `wrangler.toml` `[vars]` | Model ID. Change it here; it isn't hard-coded in the code. |
| `STATUS_URL` | `wrangler.toml` | GRID's published `status.json` |
| `ALLOWED_ORIGIN` | `wrangler.toml` | The only site allowed to call Ask from a browser (CORS) |
| `ANTHROPIC_API_KEY`, `ASK_PASSCODE` | Secrets Store | Never in git |

## Limits and safety
- **Passcode:** required on every request, compared in constant time.
- **Rate limit:** 12 questions per hour per IP, best effort per Worker instance. The Anthropic spend limit is the hard cap.
- **Input and tool limits:** questions are capped at 500 characters. At most 6 tool rounds per answer, 10-second fetch timeout, 12,000 characters per fetched page.
- **Refusal fallback:** if the model declines on safety grounds, the API retries on a fallback model in the same call (`fallbacks: "default"`). Otherwise the user gets a short "could not be answered" message.

## Test
`npm ci && npm test`. The tests use a scripted model client and fake web responses, so no API key is needed and no money is spent.
