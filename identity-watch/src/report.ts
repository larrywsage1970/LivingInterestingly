// Build the short email: what, where, what to do.
import { breachAdvice } from "./sources/hibp.ts";
import { brokerForHost } from "./brokers.ts";
import { hostOf } from "./sources/websearch.ts";
import type { BrokerRow, RunKind, StoredFinding } from "./types.ts";

export interface ReportInput {
  kind: RunKind;
  date: string;
  findings: StoredFinding[];
  brokersDue: BrokerRow[];
  errors: string[];
  dashboardUrl?: string;
}

export interface Report {
  subject: string;
  text: string;
  html: string;
}

interface Item {
  what: string;
  where: string;
  todo: string;
}

const LISTED = ["unknown", "listed", "not listed"];

export function buildReport(r: ReportInput): Report {
  const n = r.findings.length;
  const errNote = r.errors.length ? ` (${r.errors.length} error${r.errors.length > 1 ? "s" : ""})` : "";
  const subject = n
    ? `Identity Watch: ${n} new finding${n > 1 ? "s" : ""}${errNote}`
    : `Identity Watch: all clear${errNote}`;

  const breaches: Item[] = r.findings
    .filter((f) => f.source === "hibp")
    .map((f) => ({
      what: `${f.title} breach exposed ${f.identifier}`,
      where: [f.url, f.detail].filter(Boolean).join(" · "),
      todo: breachAdvice(f.detail, f.url),
    }));

  const leaks: Item[] = r.findings
    .filter((f) => f.source === "leakindex")
    .map((f) => ({
      what: `${f.identifier} appears in leak index record "${f.title}"`,
      where: f.detail || "Intelligence X",
      todo: "if it includes a password, rotate it; otherwise note it and dismiss",
    }));

  const web: Item[] = r.findings
    .filter((f) => f.source === "websearch")
    .map((f) => {
      const broker = f.url ? brokerForHost(hostOf(f.url) ?? "") : undefined;
      return {
        what: `${f.title} (matched ${f.identifier})`,
        where: f.url ?? "",
        todo: broker
          ? `data broker listing on ${broker.name}: submit opt-out, then log the date in the dashboard`
          : "open it; if it exposes address or phone, request removal or dismiss",
      };
    });

  const brokers: Item[] = r.brokersDue.map((b) => ({
    what: `${b.name} (${LISTED[b.listed] ?? "unknown"})`,
    where: b.optout_url ?? `https://${b.site} (find opt-out in footer)`,
    todo: b.optout_submitted
      ? `opt-out submitted ${b.optout_submitted}: search yourself again and confirm it is gone`
      : b.listed === 1
        ? "listed: submit the opt-out"
        : "search yourself on the site; record listed / not listed",
  }));

  const sections: [string, Item[]][] = [
    ["New breaches", breaches],
    ["New leak index hits", leaks],
    ["New web mentions", web],
    ["Brokers due for re-check", brokers],
  ];

  // ---- text ----
  const t: string[] = [`Identity Watch ${r.kind} run, ${r.date}`, ""];
  if (!n) t.push("No new breaches or mentions since the last run.", "");
  for (const [title, items] of sections) {
    if (!items.length) continue;
    t.push(`${title} (${items.length})`, "-".repeat(title.length + 4));
    for (const i of items) t.push(`* ${i.what}`, `  Where: ${i.where}`, `  Do: ${i.todo}`);
    t.push("");
  }
  if (r.errors.length) {
    t.push("Errors", "------", ...r.errors.map((e) => `* ${e}`), "");
  }
  if (r.dashboardUrl) t.push(`Dashboard: ${r.dashboardUrl}`);

  // ---- html ----
  const h: string[] = [
    `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.45;color:#1a1a1a;max-width:640px">`,
    `<p style="color:#555">Identity Watch ${esc(r.kind)} run, ${esc(r.date)}</p>`,
  ];
  if (!n) h.push(`<p><strong>All clear.</strong> No new breaches or mentions since the last run.</p>`);
  for (const [title, items] of sections) {
    if (!items.length) continue;
    h.push(`<h3 style="margin:18px 0 6px">${esc(title)} (${items.length})</h3><ul style="padding-left:18px">`);
    for (const i of items) {
      const where = /^https?:\/\//.test(i.where.split(" ")[0])
        ? `<a href="${esc(i.where.split(" ")[0])}">${esc(i.where)}</a>`
        : esc(i.where);
      h.push(`<li style="margin-bottom:8px"><strong>${esc(i.what)}</strong><br>${where}<br><em>Do:</em> ${esc(i.todo)}</li>`);
    }
    h.push("</ul>");
  }
  if (r.errors.length) {
    h.push(`<h3 style="margin:18px 0 6px;color:#a33">Errors</h3><ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`);
  }
  if (r.dashboardUrl) h.push(`<p><a href="${esc(r.dashboardUrl)}">Open dashboard</a></p>`);
  h.push("</div>");

  return { subject, text: t.join("\n"), html: h.join("") };
}

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
