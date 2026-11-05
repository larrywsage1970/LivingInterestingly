// /dashboard: list findings, set status, maintain broker checklist.
// Server-rendered, no JS, no external assets. Only reachable behind Access.
import { nextCheck } from "./brokers.ts";
import { type Env, intVar, today } from "./config.ts";
import { esc } from "./report.ts";
import type { BrokerRow } from "./types.ts";

const STATUSES = ["new", "reviewed", "actioned", "dismissed"] as const;
const LISTED = ["unknown", "listed", "not listed"];

interface FindingRow {
  id: number;
  source: string;
  identifier: string;
  title: string | null;
  url: string | null;
  detail: string | null;
  first_seen: string;
  status: string;
}

interface RunRow {
  id: number;
  started: string;
  kind: string;
  new_findings: number;
  errors: string | null;
}

export async function renderDashboard(env: Env, url: URL, who: string): Promise<Response> {
  const show = url.searchParams.get("show") === "all" ? "all" : "open";
  const where = show === "all" ? "" : "WHERE status IN ('new','reviewed')";
  const [findings, brokers, runs] = await Promise.all([
    env.DB.prepare(`SELECT * FROM findings ${where} ORDER BY first_seen DESC, id DESC LIMIT 300`).all<FindingRow>(),
    env.DB.prepare("SELECT * FROM brokers ORDER BY name").all<BrokerRow>(),
    env.DB.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 8").all<RunRow>(),
  ]);
  const msg = url.searchParams.get("msg");
  const day = today();

  const findingRows = (findings.results ?? [])
    .map(
      (f) => `<tr>
  <td>${esc(f.first_seen.slice(0, 10))}</td><td>${esc(f.source)}</td><td>${esc(f.identifier)}</td>
  <td>${f.url ? `<a href="${esc(f.url)}" rel="noreferrer noopener" target="_blank">${esc(f.title ?? f.url)}</a>` : esc(f.title ?? "")}<div class="d">${esc(f.detail ?? "")}</div></td>
  <td><form method="post" action="/findings/${f.id}"><select name="status">${STATUSES.map((s) => `<option${s === f.status ? " selected" : ""}>${s}</option>`).join("")}</select> <button>Save</button></form></td>
</tr>`,
    )
    .join("");

  const brokerRows = (brokers.results ?? [])
    .map((b) => {
      const due = !b.next_check || b.next_check <= day;
      const f = `form="b${b.id}"`;
      return `<tr${due ? ' class="due"' : ""}>
  <td><form id="b${b.id}" method="post" action="/brokers/${b.id}"></form><strong>${esc(b.name)}</strong><div class="d">${b.site ? `<a href="https://${esc(b.site)}" rel="noreferrer noopener" target="_blank">${esc(b.site)}</a>` : ""}</div></td>
  <td><select ${f} name="listed">${LISTED.map((l, i) => `<option value="${i}"${i === b.listed ? " selected" : ""}>${l}</option>`).join("")}</select></td>
  <td><input ${f} type="date" name="optout_submitted" value="${esc(b.optout_submitted ?? "")}"></td>
  <td>${esc(b.next_check ?? "now")}${due ? " <b>due</b>" : ""}</td>
  <td><input ${f} name="optout_url" value="${esc(b.optout_url ?? "")}" placeholder="opt-out URL">${b.optout_url ? ` <a href="${esc(b.optout_url)}" rel="noreferrer noopener" target="_blank">open</a>` : ""}<textarea ${f} name="notes" rows="2">${esc(b.notes ?? "")}</textarea></td>
  <td><button ${f}>Save</button></td>
</tr>`;
    })
    .join("");

  const runRows = (runs.results ?? [])
    .map(
      (r) =>
        `<li>${esc(r.started.slice(0, 16).replace("T", " "))} UTC · ${esc(r.kind)} · ${r.new_findings} new${r.errors ? ` · <span class="err">${(JSON.parse(r.errors) as string[]).length} error(s)</span>` : ""}</li>`,
    )
    .join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Identity Watch</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#e3e3e3;--due:#fff6e0;--acc:#2456c7}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#9a9a9a;--line:#2c2c2c;--due:#2e2610;--acc:#8fb0ff}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1200px}
a{color:var(--acc)}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}
.d{color:var(--mut);font-size:12px}.due{background:var(--due)}.err{color:#c44}.msg{padding:8px;border:1px solid var(--line);margin:8px 0}
input,select,textarea,button{font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);padding:3px 6px}
textarea{width:100%;margin-top:4px;box-sizing:border-box}.wrap{overflow-x:auto}
</style></head><body>
<h1>Identity Watch</h1><div class="d">Signed in as ${esc(who)} · ${esc(day)}</div>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<form method="post" action="/run" style="margin-top:10px"><button>Run full scan now</button> <span class="d">Emails a report. Takes up to a minute.</span></form>

<h2>Findings (${show === "all" ? "all" : "open"}) · <a href="?show=${show === "all" ? "open" : "all"}">show ${show === "all" ? "open only" : "all"}</a></h2>
<div class="wrap"><table><tr><th>First seen</th><th>Source</th><th>Identifier</th><th>Finding</th><th>Status</th></tr>
${findingRows || '<tr><td colspan="5">Nothing open.</td></tr>'}</table></div>

<h2>Data brokers</h2>
<div class="d">Mark listed / not listed after you search yourself. Enter the date you submitted an opt-out; it comes due again ${intVar(env.BROKER_RECHECK_DAYS, 90)} days later to confirm it stuck.</div>
<div class="wrap"><table><tr><th>Broker</th><th>Listed</th><th>Opt-out submitted</th><th>Next check</th><th>Opt-out URL / notes</th><th></th></tr>
${brokerRows || '<tr><td colspan="6">No brokers yet. Run a full scan to seed the list.</td></tr>'}</table></div>

<h2>Recent runs</h2><ul>${runRows || "<li>None yet.</li>"}</ul>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
}

export const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

export async function updateFinding(env: Env, id: number, form: FormData): Promise<string> {
  const status = String(form.get("status") ?? "");
  if (!(STATUSES as readonly string[]).includes(status)) return "Invalid status";
  const r = await env.DB.prepare("UPDATE findings SET status = ? WHERE id = ?").bind(status, id).run();
  return r.meta.changes ? `Finding ${id} marked ${status}` : "Finding not found";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function updateBroker(env: Env, id: number, form: FormData): Promise<string> {
  const listed = Number(form.get("listed"));
  if (![0, 1, 2].includes(listed)) return "Invalid listed value";
  const submittedRaw = String(form.get("optout_submitted") ?? "").trim();
  if (submittedRaw && !DATE_RE.test(submittedRaw)) return "Invalid date";
  const submitted = submittedRaw || null;
  const optoutUrl = String(form.get("optout_url") ?? "").trim() || null;
  if (optoutUrl && !/^https:\/\/[^\s]+$/.test(optoutUrl)) return "Opt-out URL must start with https://";
  const notes = String(form.get("notes") ?? "").slice(0, 1000);
  const next = nextCheck(listed, submitted, today(), intVar(env.BROKER_RECHECK_DAYS, 90));
  const r = await env.DB.prepare(
    "UPDATE brokers SET listed = ?, optout_submitted = ?, optout_url = ?, notes = ?, next_check = ? WHERE id = ?",
  )
    .bind(listed, submitted, optoutUrl, notes, next, id)
    .run();
  return r.meta.changes ? `Broker saved${next ? `; next check ${next}` : ""}` : "Broker not found";
}
