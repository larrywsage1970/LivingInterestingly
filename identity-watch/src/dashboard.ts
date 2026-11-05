// /dashboard and its forms. Server-rendered, no JS, no external assets.
// Only reachable behind Cloudflare Access (see access.ts / index.ts).
import { brokerForHost, nextCheck } from "./brokers.ts";
import { type Env, intVar, loadIdentifiers, today } from "./config.ts";
import {
  composeRemoval,
  type Draft,
  EMAIL_RE,
  GOOGLE_OUTDATED_CONTENT,
  GOOGLE_RESULTS_ABOUT_YOU,
  logFormSubmitted,
  profileUrlsForBroker,
  replyAddress,
  requestSender,
  sendRemovalRequest,
} from "./removal.ts";
import { esc } from "./report.ts";
import { hostOf } from "./sources/websearch.ts";
import type { BrokerRow, RemovalRequestRow } from "./types.ts";

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

export const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const ext = (href: string, label: string) => `<a href="${esc(href)}" rel="noreferrer noopener" target="_blank">${esc(label)}</a>`;
const btn = (action: string, label: string, opts: { cls?: string } = {}) =>
  `<form method="post" action="${esc(action)}" class="inl"><button${opts.cls ? ` class="${opts.cls}"` : ""}>${esc(label)}</button></form>`;

function page(title: string, who: string, body: string, msg?: string | null): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#e3e3e3;--due:#fff6e0;--acc:#2456c7;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#9a9a9a;--line:#2c2c2c;--due:#2e2610;--acc:#8fb0ff;--bad:#ff8a80}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1200px}
a{color:var(--acc)}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}
.d{color:var(--mut);font-size:12px}.due{background:var(--due)}.err{color:var(--bad)}.msg{padding:8px;border:1px solid var(--line);margin:8px 0}
input,select,textarea,button{font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);padding:3px 6px}
button{cursor:pointer}button.del{color:var(--bad)}
textarea{width:100%;margin-top:4px;box-sizing:border-box}.wrap{overflow-x:auto}.inl{display:inline}
.acts{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}label{display:block;margin:10px 0 2px;font-weight:600}
input.w{width:100%;box-sizing:border-box}
</style></head><body>
<h1><a href="/dashboard" style="color:inherit;text-decoration:none">Identity Watch</a></h1><div class="d">Signed in as ${esc(who)} · ${esc(today())}</div>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
${body}
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
}

// ---------------------------------------------------------------- main page

export async function renderDashboard(env: Env, url: URL, who: string): Promise<Response> {
  const show = url.searchParams.get("show") === "all" ? "all" : "open";
  const where = show === "all" ? "" : "WHERE status IN ('new','reviewed')";
  const [findings, brokers, requests, runs, dismissed] = await Promise.all([
    env.DB.prepare(`SELECT * FROM findings ${where} ORDER BY first_seen DESC, id DESC LIMIT 300`).all<FindingRow>(),
    env.DB.prepare("SELECT * FROM brokers ORDER BY removed, name").all<BrokerRow>(),
    env.DB.prepare("SELECT * FROM removal_requests ORDER BY id DESC LIMIT 50").all<RemovalRequestRow>(),
    env.DB.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 8").all<RunRow>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM findings WHERE status = 'dismissed'").first<{ n: number }>(),
  ]);
  const day = today();
  const recheckDays = intVar(env.BROKER_RECHECK_DAYS, 90);

  const findingRows = (findings.results ?? [])
    .map((f) => {
      const host = f.url ? hostOf(f.url) : null;
      const broker = host ? brokerForHost(host) : undefined;
      const removeAct =
        f.source === "websearch" && !broker ? `<a href="/findings/${f.id}/request">Request removal</a>` : broker ? `<span class="d">broker: use ${esc(broker.name)} row below</span>` : "";
      return `<tr>
  <td>${esc(f.first_seen.slice(0, 10))}</td><td>${esc(f.source)}</td><td>${esc(f.identifier)}</td>
  <td>${f.url ? ext(f.url, f.title ?? f.url) : esc(f.title ?? "")}<div class="d">${esc(f.detail ?? "")}</div></td>
  <td><form method="post" action="/findings/${f.id}" class="inl"><select name="status">${STATUSES.map((s) => `<option${s === f.status ? " selected" : ""}>${s}</option>`).join("")}</select> <button>Save</button></form>
    <div class="acts">${removeAct}${btn(`/findings/${f.id}/delete`, "Delete", { cls: "del" })}</div></td>
</tr>`;
    })
    .join("");

  const brokerRows = (brokers.results ?? [])
    .map((b) => {
      if (b.removed) {
        return `<tr class="d"><td>${esc(b.name)}</td><td colspan="4">Removed from your list (won't be re-added).</td><td>${btn(`/brokers/${b.id}/restore`, "Restore")}</td></tr>`;
      }
      const due = !b.next_check || b.next_check <= day;
      const f = `form="b${b.id}"`;
      const actions = [
        b.optout_email ? `<a href="/brokers/${b.id}/request">Email request</a>` : "",
        b.optout_url ? ext(b.optout_url, "Open form") : "",
        btn(`/brokers/${b.id}/form-submitted`, "Submitted form today"),
        btn(`/brokers/${b.id}/delete`, "Remove", { cls: "del" }),
      ].filter(Boolean);
      return `<tr${due ? ' class="due"' : ""}>
  <td><form id="b${b.id}" method="post" action="/brokers/${b.id}"></form><strong>${esc(b.name)}</strong><div class="d">${b.site ? ext(`https://${b.site}`, b.site) : ""}</div></td>
  <td><select ${f} name="listed">${LISTED.map((l, i) => `<option value="${i}"${i === b.listed ? " selected" : ""}>${l}</option>`).join("")}</select></td>
  <td><input ${f} type="date" name="optout_submitted" value="${esc(b.optout_submitted ?? "")}"></td>
  <td>${esc(b.next_check ?? "now")}${due ? " <b>due</b>" : ""}</td>
  <td><input ${f} class="w" name="optout_url" value="${esc(b.optout_url ?? "")}" placeholder="opt-out form URL (https://...)">
      <input ${f} class="w" name="optout_email" value="${esc(b.optout_email ?? "")}" placeholder="privacy email (optional)" style="margin-top:4px">
      <textarea ${f} name="notes" rows="2">${esc(b.notes ?? "")}</textarea>
      <div class="acts">${actions.join("")}</div></td>
  <td><button ${f}>Save</button></td>
</tr>`;
    })
    .join("");

  const requestRows = (requests.results ?? [])
    .map(
      (r) => `<tr${r.status === "sent" && r.recheck_on && r.recheck_on <= day ? ' class="due"' : ""}>
  <td>${esc(r.sent_at.slice(0, 10))}</td><td>${esc(r.target_name)}</td><td>${esc(r.channel)}${r.recipient ? `<div class="d">${esc(r.recipient)}</div>` : ""}</td>
  <td>${esc(r.recheck_on ?? "")}</td><td>${esc(r.status)}</td>
  <td><div class="acts">${r.status !== "confirmed" ? btn(`/requests/${r.id}/confirmed`, "Gone: confirm") : ""}${r.status !== "failed" ? btn(`/requests/${r.id}/failed`, "Still there") : ""}</div></td>
</tr>`,
    )
    .join("");

  const runRows = (runs.results ?? [])
    .map(
      (r) =>
        `<li>${esc(r.started.slice(0, 16).replace("T", " "))} UTC · ${esc(r.kind)} · ${r.new_findings} new${r.errors ? ` · <span class="err">${(JSON.parse(r.errors) as string[]).length} error(s)</span>` : ""}</li>`,
    )
    .join("");

  const sendingNote = requestSender(env)
    ? `Requests go from ${esc(requestSender(env)!)}; replies and a BCC copy go to ${esc(replyAddress(env) || "(set REPORT_TO)")}.`
    : `<span class="err">Email requests are off until REQUEST_FROM is set to an address on a domain verified in Resend.</span> Form tracking works now.`;

  const body = `
<form method="post" action="/run" style="margin-top:10px" class="inl"><button>Run full scan now</button></form> <span class="d">Emails a report. Takes up to a minute.</span>

<h2>Remove yourself from Google results</h2>
<div class="d">Covers the most ground for the least effort. Google removes results showing your phone, home address, or email, and can alert you to new ones.</div>
<p>${ext(GOOGLE_RESULTS_ABOUT_YOU, "Results about you")} · ${ext(GOOGLE_OUTDATED_CONTENT, "Remove outdated content")} <span class="d">(for pages already taken down that still show in Google)</span></p>

<h2>Findings (${show === "all" ? "all" : "open"}) · <a href="?show=${show === "all" ? "open" : "all"}">show ${show === "all" ? "open only" : "all"}</a></h2>
<div class="d"><b>Dismiss</b> = keep the record and never alert on it again. <b>Delete</b> = forget it; if it is still out there the next scan reports it as new.</div>
<div class="wrap"><table><tr><th>First seen</th><th>Source</th><th>Identifier</th><th>Finding</th><th>Status / actions</th></tr>
${findingRows || '<tr><td colspan="5">Nothing open.</td></tr>'}</table></div>
${dismissed?.n ? `<p>${btn("/findings/delete-dismissed", `Delete all ${dismissed.n} dismissed`, { cls: "del" })} <span class="d">They stop counting as seen, so any still online will alert again.</span></p>` : ""}

<h2>Data brokers</h2>
<div class="d">Search yourself on each site and set listed / not listed. "Email request" drafts a deletion request for you to review and send. "Submitted form today" logs a web-form opt-out. Either one schedules a re-check ${recheckDays} days later to confirm it stuck. ${sendingNote}</div>
<div class="wrap"><table><tr><th>Broker</th><th>Listed</th><th>Opt-out submitted</th><th>Next check</th><th>Opt-out / notes / actions</th><th></th></tr>
${brokerRows || '<tr><td colspan="6">No brokers yet. Run a full scan to seed the list.</td></tr>'}</table></div>
<form method="post" action="/brokers/new" style="margin-top:10px">
  <b>Add broker:</b> <input name="name" placeholder="Name" required maxlength="80"> <input name="site" placeholder="domain.com" required maxlength="120">
  <input name="optout_url" placeholder="https://opt-out form (optional)"> <input name="optout_email" placeholder="privacy email (optional)"> <button>Add</button>
</form>

<h2>Removal requests</h2>
<div class="wrap"><table><tr><th>Sent</th><th>Target</th><th>Channel</th><th>Re-check</th><th>Status</th><th></th></tr>
${requestRows || '<tr><td colspan="6">None yet.</td></tr>'}</table></div>

<h2>Recent runs</h2><ul>${runRows || "<li>None yet.</li>"}</ul>`;
  return page("Identity Watch", who, body, url.searchParams.get("msg"));
}

// ---------------------------------------------------------------- finding edits

export async function updateFinding(env: Env, id: number, form: FormData): Promise<string> {
  const status = String(form.get("status") ?? "");
  if (!(STATUSES as readonly string[]).includes(status)) return "Invalid status";
  const r = await env.DB.prepare("UPDATE findings SET status = ? WHERE id = ?").bind(status, id).run();
  return r.meta.changes ? `Finding ${id} marked ${status}` : "Finding not found";
}

export async function deleteFinding(env: Env, id: number): Promise<string> {
  const r = await env.DB.prepare("DELETE FROM findings WHERE id = ?").bind(id).run();
  return r.meta.changes ? `Finding ${id} deleted` : "Finding not found";
}

export async function deleteDismissed(env: Env): Promise<string> {
  const r = await env.DB.prepare("DELETE FROM findings WHERE status = 'dismissed'").run();
  return `Deleted ${r.meta.changes} dismissed finding(s)`;
}

// ---------------------------------------------------------------- broker edits

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS_RE = /^https:\/\/[^\s"<>]+$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function optionalEmail(v: unknown): string | null | false {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return EMAIL_RE.test(s) ? s : false;
}

export async function updateBroker(env: Env, id: number, form: FormData): Promise<string> {
  const listed = Number(form.get("listed"));
  if (![0, 1, 2].includes(listed)) return "Invalid listed value";
  const submittedRaw = String(form.get("optout_submitted") ?? "").trim();
  if (submittedRaw && !DATE_RE.test(submittedRaw)) return "Invalid date";
  const submitted = submittedRaw || null;
  const optoutUrl = String(form.get("optout_url") ?? "").trim() || null;
  if (optoutUrl && !HTTPS_RE.test(optoutUrl)) return "Opt-out URL must start with https://";
  const optoutEmail = optionalEmail(form.get("optout_email"));
  if (optoutEmail === false) return "Privacy email is not a valid address";
  const notes = String(form.get("notes") ?? "").slice(0, 1000);
  const next = nextCheck(listed, submitted, today(), intVar(env.BROKER_RECHECK_DAYS, 90));
  const r = await env.DB.prepare(
    "UPDATE brokers SET listed = ?, optout_submitted = ?, optout_url = ?, optout_email = ?, notes = ?, next_check = ? WHERE id = ? AND removed = 0",
  )
    .bind(listed, submitted, optoutUrl, optoutEmail, notes, next, id)
    .run();
  return r.meta.changes ? `Broker saved${next ? `; next check ${next}` : ""}` : "Broker not found";
}

export async function addBroker(env: Env, form: FormData): Promise<string> {
  const name = String(form.get("name") ?? "").trim().slice(0, 80);
  const site = String(form.get("site") ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!name) return "Broker name is required";
  if (!DOMAIN_RE.test(site)) return "Site must be a domain like example.com";
  const optoutUrl = String(form.get("optout_url") ?? "").trim() || null;
  if (optoutUrl && !HTTPS_RE.test(optoutUrl)) return "Opt-out URL must start with https://";
  const optoutEmail = optionalEmail(form.get("optout_email"));
  if (optoutEmail === false) return "Privacy email is not a valid address";
  const r = await env.DB.prepare("INSERT OR IGNORE INTO brokers (name, site, optout_url, optout_email, notes) VALUES (?, ?, ?, ?, ?)")
    .bind(name, site, optoutUrl, optoutEmail, "Added by you.")
    .run();
  return r.meta.changes ? `${name} added` : `${name} is already on the list (restore it if you removed it)`;
}

/** Soft delete: the row stays as a tombstone so the seed list never re-adds it. */
export async function removeBroker(env: Env, id: number, removed: boolean): Promise<string> {
  const r = await env.DB.prepare("UPDATE brokers SET removed = ? WHERE id = ?").bind(removed ? 1 : 0, id).run();
  return r.meta.changes ? (removed ? "Broker removed from your list" : "Broker restored") : "Broker not found";
}

export async function brokerFormSubmitted(env: Env, id: number): Promise<string> {
  const b = await env.DB.prepare("SELECT * FROM brokers WHERE id = ? AND removed = 0").bind(id).first<BrokerRow>();
  return b ? logFormSubmitted(env, b) : "Broker not found";
}

// ---------------------------------------------------------------- removal requests

type Target = { type: "broker" | "finding"; id: number; name: string; to: string; profileUrls: string[] };

async function loadTarget(env: Env, type: "broker" | "finding", id: number): Promise<Target | string> {
  if (type === "broker") {
    const b = await env.DB.prepare("SELECT * FROM brokers WHERE id = ? AND removed = 0").bind(id).first<BrokerRow>();
    if (!b) return "Broker not found";
    return { type, id, name: b.name, to: b.optout_email ?? "", profileUrls: await profileUrlsForBroker(env.DB, b) };
  }
  const f = await env.DB.prepare("SELECT * FROM findings WHERE id = ?").bind(id).first<FindingRow>();
  if (!f || !f.url) return "Finding not found";
  return { type, id, name: hostOf(f.url) ?? f.url, to: "", profileUrls: [f.url] };
}

export async function renderRequestForm(
  env: Env,
  type: "broker" | "finding",
  id: number,
  who: string,
  msg?: string,
  edited?: Draft,
): Promise<Response> {
  const t = await loadTarget(env, type, id);
  if (typeof t === "string") return page("Not found", who, `<p>${esc(t)}</p>`);
  let draft: { subject: string; body: string };
  try {
    draft = composeRemoval({ ids: loadIdentifiers(env), siteName: t.name, profileUrls: t.profileUrls, replyTo: replyAddress(env), broker: type === "broker" });
  } catch (e) {
    return page("Setup needed", who, `<p class="err">${esc((e as Error).message)}</p>`);
  }
  if (edited) draft = { subject: edited.subject, body: edited.body };
  const to = edited ? edited.to : t.to;
  const sender = requestSender(env);
  const recipientHelp =
    type === "finding"
      ? `Look for a privacy, contact, or "report" address on ${esc(t.name)}. If there is only a web form, paste this text into it instead and mark the finding actioned. If the page is already gone but still shows in Google, use ${ext(GOOGLE_OUTDATED_CONTENT, "Remove outdated content")}.`
      : `From the broker list (unverified). Check the broker's privacy page if you are unsure.`;
  const body = `
<h2>Removal request: ${esc(t.name)}</h2>
${sender ? "" : `<p class="err">Sending is off: set REQUEST_FROM to an address on a domain verified in Resend (README, "Removal requests"). You can still copy this text into a web form.</p>`}
<form method="post" action="/${type === "broker" ? "brokers" : "findings"}/${id}/request">
  <label>To</label><input class="w" name="to" value="${esc(to)}" placeholder="privacy@site.com" required>
  <div class="d">${recipientHelp}</div>
  <label>Subject</label><input class="w" name="subject" value="${esc(draft.subject)}" required maxlength="200">
  <label>Message</label><textarea name="body" rows="22" required>${esc(draft.body)}</textarea>
  <div class="d">Edit anything. It goes out exactly as shown, from ${esc(sender ?? "(not set)")}, reply-to and BCC ${esc(replyAddress(env) || "(not set)")}. Never add an SSN, DOB, or ID number.</div>
  <p><button${sender ? "" : " disabled"}>Send request</button> <a href="/dashboard">Cancel</a></p>
</form>`;
  return page(`Request: ${t.name}`, who, body, msg);
}

export async function submitRequest(
  env: Env,
  type: "broker" | "finding",
  id: number,
  form: FormData,
): Promise<{ ok: boolean; message: string; draft?: Draft }> {
  const t = await loadTarget(env, type, id);
  if (typeof t === "string") return { ok: false, message: t };
  const d: Draft = {
    to: String(form.get("to") ?? "").trim(),
    subject: String(form.get("subject") ?? "").trim(),
    body: String(form.get("body") ?? "").replace(/\r\n/g, "\n"),
  };
  return { ...(await sendRemovalRequest(env, { type, id, name: t.name }, d)), draft: d };
}
