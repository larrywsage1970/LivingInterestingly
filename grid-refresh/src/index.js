/**
 * GRID refresh - Cloudflare Worker.
 *
 * scheduled (cron, every 15 min): start the GRID GitHub Actions workflow.
 * POST /refresh : start it now from the app's Refresh button, unless a run is already
 *                 queued/running or one started within MIN_GAP_SECONDS (global limit kept
 *                 by GitHub itself, so no storage is needed).
 * GET  /health  : { ok: true }
 *
 * The GitHub token is a fine-grained token limited to this one repository with
 * Actions: Read and write. It never leaves the Worker.
 */

const API = "https://api.github.com";

async function token(env) {
  const b = env.GITHUB_TOKEN;
  if (!b) return "";
  return typeof b === "string" ? b : (await b.get()) || "";
}

function gh(env, tok, path, init = {}) {
  return fetch(`${API}/repos/${env.GH_OWNER}/${env.GH_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "GRID-refresh-worker",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

/** Newest run of the workflow, or null. */
export async function latestRun(env, tok) {
  const r = await gh(env, tok, `/actions/workflows/${env.GH_WORKFLOW}/runs?per_page=1`);
  if (!r.ok) throw new Error(`GitHub runs HTTP ${r.status}`);
  const d = await r.json();
  return (d.workflow_runs || [])[0] || null;
}

export async function dispatch(env, tok) {
  const r = await gh(env, tok, `/actions/workflows/${env.GH_WORKFLOW}/dispatches`, {
    method: "POST", body: JSON.stringify({ ref: env.GH_REF || "main" }),
  });
  if (r.status !== 204) throw new Error(`GitHub dispatch HTTP ${r.status}`);
}

/** Decide whether to start a run now. Returns {action, ...}. */
export async function maybeRun(env, tok, now = Date.now()) {
  const gap = Number(env.MIN_GAP_SECONDS || 180) * 1000;
  const last = await latestRun(env, tok);
  if (last && ["queued", "in_progress", "waiting", "requested", "pending"].includes(last.status)) {
    return { action: "already_running", started_at: last.run_started_at || last.created_at };
  }
  if (last && now - Date.parse(last.created_at) < gap) {
    return { action: "recent", started_at: last.created_at };
  }
  await dispatch(env, tok);
  return { action: "started", started_at: new Date(now).toISOString() };
}

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(env) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    if (url.pathname === "/health") return json({ ok: true }, 200, env);
    if (url.pathname !== "/refresh" || request.method !== "POST") return json({ error: "not found" }, 404, env);
    const tok = await token(env);
    if (!tok) return json({ error: "Refresh is not configured yet." }, 503, env);
    try {
      return json(await maybeRun(env, tok), 200, env);
    } catch (e) {
      console.log(JSON.stringify({ event: "refresh_error", message: String(e?.message || e) }));
      return json({ error: "Could not start an update right now." }, 502, env);
    }
  },

  async scheduled(event, env, ctx) {
    const tok = await token(env);
    if (!tok) return;
    ctx.waitUntil(maybeRun(env, tok).then(
      (r) => console.log(JSON.stringify({ event: "cron", ...r })),
      (e) => console.log(JSON.stringify({ event: "cron_error", message: String(e?.message || e) })),
    ));
  },
};
