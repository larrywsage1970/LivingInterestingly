// Reads identifiers and settings from Worker env. Identifiers live ONLY in the
// IDENTIFIERS_JSON secret, never in the repo. Never log values from here.

export interface Env {
  DB: D1Database;

  // Secrets (wrangler secret put)
  IDENTIFIERS_JSON?: string;
  HIBP_API_KEY?: string;
  BRAVE_API_KEY?: string;
  INTELX_API_KEY?: string;
  RESEND_API_KEY?: string;
  REPORT_TO?: string;

  // Vars (wrangler.toml)
  REPORT_FROM?: string;
  DASHBOARD_URL?: string;
  WEBSEARCH_ENABLED?: string;
  LEAKINDEX_ENABLED?: string;
  IGNORE_DOMAINS?: string;
  BROKER_RECHECK_DAYS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;

  // Testing / tuning overrides (local .dev.vars only)
  DRY_RUN?: string;
  HIBP_BASE_URL?: string;
  BRAVE_BASE_URL?: string;
  INTELX_BASE_URL?: string;
  RESEND_BASE_URL?: string;
  HIBP_DELAY_MS?: string;
  BRAVE_DELAY_MS?: string;
}

export interface Identifiers {
  emails: string[];
  names: string[];
  city: string;
  phones: string[];
}

const strList = (v: unknown, field: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`IDENTIFIERS_JSON.${field} must be an array of strings`);
  }
  return v.map((x) => x.trim()).filter(Boolean);
};

// Guard for security rule: no SSNs, card/bank numbers, or government IDs.
const SSN_RE = /\b\d{3}-?\d{2}-?\d{4}\b/;
// 13+ digits in one value looks like a card or account number.

function assertNoSensitive(label: string, value: string): void {
  const digitsOnly = value.replace(/\D/g, "");
  if (label !== "phones" && SSN_RE.test(value)) {
    throw new Error(`IDENTIFIERS_JSON.${label} contains an SSN-like number. Remove it.`);
  }
  if (digitsOnly.length >= 13) {
    throw new Error(`IDENTIFIERS_JSON.${label} contains an account/card-like number. Remove it.`);
  }
}

export function loadIdentifiers(env: Env): Identifiers {
  if (!env.IDENTIFIERS_JSON) throw new Error("IDENTIFIERS_JSON secret is not set");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(env.IDENTIFIERS_JSON);
  } catch {
    throw new Error("IDENTIFIERS_JSON is not valid JSON");
  }
  const ids: Identifiers = {
    emails: strList(raw.emails, "emails").map((e) => e.toLowerCase()),
    names: strList(raw.names, "names"),
    city: typeof raw.city === "string" ? raw.city.trim() : "",
    phones: strList(raw.phones, "phones"),
  };
  const allowed = new Set(["emails", "names", "city", "phones"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`IDENTIFIERS_JSON has unsupported field "${k}"`);
  }
  for (const [label, values] of Object.entries(ids)) {
    for (const v of Array.isArray(values) ? values : [values]) assertNoSensitive(label, v);
  }
  for (const e of ids.emails) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("IDENTIFIERS_JSON.emails has an invalid address");
  }
  if (ids.emails.length === 0 && ids.names.length === 0) {
    throw new Error("IDENTIFIERS_JSON needs at least one email or name");
  }
  return ids;
}

export const flag = (v: string | undefined, dflt = false): boolean =>
  v === undefined || v === "" ? dflt : ["1", "true", "yes", "on"].includes(v.toLowerCase());

export const intVar = (v: string | undefined, dflt: number): number => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

export function ignoreDomains(env: Env): string[] {
  return (env.IGNORE_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
}

/** For logs and error messages: t***@example.com, T*** P***. */
export function mask(identifier: string): string {
  const at = identifier.indexOf("@");
  if (at > 0) return `${identifier[0]}***${identifier.slice(at)}`;
  return identifier
    .split(/\s+/)
    .map((w) => (w ? `${w[0]}***` : w))
    .join(" ");
}

export const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

export const today = (d = new Date()): string => d.toISOString().slice(0, 10);

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return today(d);
}
