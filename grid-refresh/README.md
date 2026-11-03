# GRID refresh (Cloudflare Worker)

Keeps GRID current, because GitHub's own scheduled runs are not guaranteed (on 2026-11-03 none ran for 5+ hours).

- **Every 15 minutes** (Cloudflare cron), it starts the GRID GitHub Actions workflow.
- **The app's Refresh button** calls `POST /refresh`, which starts the workflow right away. The app then waits for the new data, about 1–2 minutes.
- **Limit:** it won't start a run if one is already queued or running, or if one started in the last 3 minutes (`MIN_GAP_SECONDS`). This limit is enforced through GitHub's own run history, so no storage is needed.
- **Token:** the GitHub token stays inside the Worker and is never sent to the browser.

## One-time setup (about 10 minutes)

### 1. GitHub token (fine-grained, this repo only)
1. Go to https://github.com/settings/personal-access-tokens/new
2. **Token name:** `GRID refresh`. **Expiration:** 1 year. Set a calendar reminder to renew it.
3. **Resource owner:** `larrywsage1970`
4. **Repository access:** *Only select repositories* → `LivingInterestingly`
5. **Permissions → Repository permissions → Actions:** **Read and write**. Leave everything else at No access; *Metadata: Read* is added automatically.
6. **Generate token**, then copy it. GitHub shows it only once.

### 2. Cloudflare secret
Workers & Pages → **Secrets Store** → Create secret:
- **Name:** `GRID_GITHUB_TOKEN`
- **Value:** the token from step 1

Use the same store as `youtube-transcript`. If your store ID isn't `51e50219e2f045c38a0b4956ae04726c`, update `wrangler.toml`.

### 3. Deploy the Worker from Git
Workers & Pages → **Create** → **Import a repository** → `LivingInterestingly`
- **Root directory:** `grid-refresh`
- **Deploy branch:** `main`. No build command is needed.

After it deploys, copy the URL (for example `https://grid-refresh.<you>.workers.dev`) and check that `…/health` shows `{"ok":true}`.

### 4. Tell GRID the URL
GitHub repo → Settings → Secrets and variables → Actions → **Variables** → New:
- **Name:** `SGW_REFRESH_URL`
- **Value:** the Worker URL, without `/health`

The next GRID update turns on the real Refresh button.

## Check it's working
In GitHub → Actions → GRID, a new **workflow_dispatch** run should appear about every 15 minutes.

## Test
`npm test` (no network, no token needed).
