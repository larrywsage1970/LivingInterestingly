// Removal requests. You review every request before it goes out: the dashboard
// shows a pre-filled draft, you edit it, you press Send. Nothing is sent from
// the cron. Form-only brokers get a "submitted" log entry instead.
import { brokerForHost } from "./brokers.ts";
import { addDays, type Env, type Identifiers, intVar, today } from "./config.ts";
import { sendEmail } from "./mail.ts";
import { hostOf } from "./sources/websearch.ts";
import type { BrokerRow, RemovalRequestRow } from "./types.ts";

export const GOOGLE_RESULTS_ABOUT_YOU = "https://myactivity.google.com/results-about-you";
export const GOOGLE_OUTDATED_CONTENT = "https://search.google.com/search-console/remove-outdated-content";

export const EMAIL_RE = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;
const MAX_BODY = 6000;

export interface Draft {
  to: string;
  subject: string;
  body: string;
}

/**
 * The request letter. Deliberately gives only what a site needs to find your
 * records: names, city, the profile URLs, and a reply address. No phone, DOB,
 * or anything else unless you add it in the preview.
 */
export function composeRemoval(opts: {
  ids: Identifiers;
  siteName: string;
  profileUrls: string[];
  replyTo: string;
  broker: boolean;
}): { subject: string; body: string } {
  const { ids, siteName, profileUrls, replyTo, broker } = opts;
  const signer = ids.names[0] ?? "";
  const lines = [
    `To the ${siteName} privacy team,`,
    "",
    broker
      ? `I request that you delete all personal information you hold about me, remove every listing or profile about me from ${siteName} and any affiliated sites, and stop selling or sharing my personal information.`
      : `A page on ${siteName} publishes my personal information. I request that you remove it, or remove my personal details from it.`,
    "",
    "Use the details below only to find and remove my records:",
  ];
  if (ids.names.length) lines.push(`Name${ids.names.length > 1 ? "s" : ""}: ${ids.names.join("; ")}`);
  if (ids.city) lines.push(`Location: ${ids.city}`);
  lines.push(`Contact email: ${replyTo}`);
  if (profileUrls.length) {
    lines.push(`Page${profileUrls.length > 1 ? "s" : ""}:`, ...profileUrls.map((u) => `  ${u}`));
  } else if (broker) {
    lines.push("Page(s): [paste your profile URL(s) here]");
  }
  lines.push(
    "",
    "Please confirm by reply when this is done. If you need more to verify my identity, tell me exactly what and why; I will not send government ID numbers by email.",
    "",
    "Thank you,",
    signer,
  );
  return {
    subject: broker ? "Personal data deletion and opt-out request" : "Request to remove my personal information",
    body: lines.join("\n"),
  };
}

/** Web findings whose URL is on this broker's domain. */
export async function profileUrlsForBroker(db: D1Database, b: BrokerRow): Promise<string[]> {
  if (!b.site) return [];
  const { results } = await db
    .prepare("SELECT url FROM findings WHERE source = 'websearch' AND url IS NOT NULL AND status != 'dismissed' ORDER BY id")
    .all<{ url: string }>();
  return (results ?? [])
    .map((r) => r.url)
    .filter((u) => {
      const h = hostOf(u);
      return !!h && brokerForHost(h)?.site === b.site;
    });
}

export function requestSender(env: Env): string | null {
  return env.REQUEST_FROM?.trim() || null;
}

export function replyAddress(env: Env): string {
  return (env.REQUEST_REPLY_TO || env.REPORT_TO || "").trim();
}

export function validateDraft(d: Draft): string | null {
  if (!EMAIL_RE.test(d.to)) return "Recipient must be one email address";
  if (!d.subject.trim() || d.subject.length > 200) return "Subject is required (max 200 chars)";
  if (!d.body.trim() || d.body.length > MAX_BODY) return `Body is required (max ${MAX_BODY} chars)`;
  if (/\[paste your profile URL/.test(d.body)) return "Replace the profile URL placeholder first";
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(d.body)) return "Body contains an SSN-like number. Remove it.";
  return null;
}

/** Send one request (you pressed Send). BCCs you so the thread is in your inbox. */
export async function sendRemovalRequest(
  env: Env,
  target: { type: "broker" | "finding"; id: number; name: string },
  d: Draft,
  now = new Date(),
): Promise<{ ok: boolean; message: string }> {
  const invalid = validateDraft(d);
  if (invalid) return { ok: false, message: invalid };
  const from = requestSender(env);
  if (!from) return { ok: false, message: "Set REQUEST_FROM to an address on a domain verified in Resend first (see README)" };
  const replyTo = replyAddress(env);
  if (!EMAIL_RE.test(replyTo)) return { ok: false, message: "Set REQUEST_REPLY_TO (or REPORT_TO) to your email first" };

  try {
    await sendEmail(env, { from, to: [d.to], subject: d.subject, text: d.body, replyTo, bcc: [replyTo] });
  } catch (e) {
    return { ok: false, message: `Not sent: ${(e as Error).message}` };
  }
  const day = today(now);
  const recheck = recheckDate(env, target.type, day);
  await logRequest(env.DB, { ...target, channel: "email", recipient: d.to, subject: d.subject, body: d.body, sentAt: now.toISOString(), recheck });
  await markTargetSubmitted(env, target, day);
  return { ok: true, message: `Request sent to ${d.to}. Re-check on ${recheck}.` };
}

/** You submitted a broker's web form yourself: log it and schedule the re-check. */
export async function logFormSubmitted(env: Env, broker: BrokerRow, now = new Date()): Promise<string> {
  const day = today(now);
  const recheck = recheckDate(env, "broker", day);
  await logRequest(env.DB, {
    type: "broker",
    id: broker.id,
    name: broker.name,
    channel: "form",
    recipient: broker.optout_url,
    subject: null,
    body: null,
    sentAt: now.toISOString(),
    recheck,
  });
  await markTargetSubmitted(env, { type: "broker", id: broker.id, name: broker.name }, day);
  return `${broker.name}: form submission logged. Re-check on ${recheck}.`;
}

function recheckDate(env: Env, type: "broker" | "finding", day: string): string {
  return type === "broker"
    ? addDays(day, intVar(env.BROKER_RECHECK_DAYS, 90))
    : addDays(day, intVar(env.REQUEST_RECHECK_DAYS, 45));
}

async function logRequest(
  db: D1Database,
  r: {
    type: string;
    id: number;
    name: string;
    channel: string;
    recipient: string | null;
    subject: string | null;
    body: string | null;
    sentAt: string;
    recheck: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO removal_requests (target_type, target_id, target_name, channel, recipient, subject, body, sent_at, recheck_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.type, r.id, r.name, r.channel, r.recipient, r.subject, r.body, r.sentAt, r.recheck)
    .run();
}

async function markTargetSubmitted(env: Env, t: { type: string; id: number; name?: string }, day: string): Promise<void> {
  if (t.type === "broker") {
    await env.DB.prepare(
      "UPDATE brokers SET optout_submitted = ?, next_check = ?, listed = CASE WHEN listed = 0 THEN 1 ELSE listed END WHERE id = ?",
    )
      .bind(day, addDays(day, intVar(env.BROKER_RECHECK_DAYS, 90)), t.id)
      .run();
  } else {
    await env.DB.prepare("UPDATE findings SET status = 'actioned' WHERE id = ?").bind(t.id).run();
  }
}

/**
 * Site (non-broker) requests that are due for a follow-up. Broker requests are
 * covered by the broker re-check list, so they are not repeated here.
 */
export async function dueRequests(db: D1Database, todayIso: string): Promise<RemovalRequestRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM removal_requests WHERE status = 'sent' AND target_type = 'finding' AND recheck_on <= ? ORDER BY recheck_on",
    )
    .bind(todayIso)
    .all<RemovalRequestRow>();
  return results ?? [];
}

export async function setRequestStatus(db: D1Database, id: number, status: string): Promise<string> {
  if (!["sent", "confirmed", "failed"].includes(status)) return "Invalid status";
  const r = await db.prepare("UPDATE removal_requests SET status = ? WHERE id = ?").bind(status, id).run();
  return r.meta.changes ? `Request ${id} marked ${status}` : "Request not found";
}
