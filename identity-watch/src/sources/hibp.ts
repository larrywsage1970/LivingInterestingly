// Have I Been Pwned v3: one finding per breach per email.
// Stores breach name, date, and data classes only. Never credentials.
import { type Env, intVar, mask, sleep } from "../config.ts";
import { fetchWithBackoff } from "../http.ts";
import type { Finding, SourceResult } from "../types.ts";

interface HibpBreach {
  Name: string;
  Title?: string;
  Domain?: string;
  BreachDate?: string;
  DataClasses?: string[];
  IsVerified?: boolean;
  IsSensitive?: boolean;
  IsSpamList?: boolean;
}

export async function checkHibp(env: Env, emails: string[]): Promise<SourceResult> {
  const out: SourceResult = { findings: [], errors: [] };
  if (emails.length === 0) return out;
  if (!env.HIBP_API_KEY) {
    out.errors.push("HIBP: HIBP_API_KEY is not set, breach check skipped");
    return out;
  }
  const base = (env.HIBP_BASE_URL ?? "https://haveibeenpwned.com/api/v3").replace(/\/$/, "");
  // Lowest paid tier allows 10 requests/minute.
  const gapMs = intVar(env.HIBP_DELAY_MS, 6500);

  for (const [i, email] of emails.entries()) {
    if (i > 0) await sleep(gapMs);
    const url = `${base}/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`;
    let res: Response;
    try {
      res = await fetchWithBackoff(url, {
        headers: { "hibp-api-key": env.HIBP_API_KEY, "user-agent": "identity-watch" },
      });
    } catch (e) {
      out.errors.push(`HIBP: network error for ${mask(email)}: ${(e as Error).message}`);
      continue;
    }
    if (res.status === 404) continue; // not pwned
    if (!res.ok) {
      const hint = res.status === 401 ? " (API key rejected)" : res.status === 429 ? " (rate limited)" : "";
      out.errors.push(`HIBP: HTTP ${res.status}${hint} for ${mask(email)}`);
      await res.body?.cancel();
      continue;
    }
    let breaches: HibpBreach[];
    try {
      breaches = (await res.json()) as HibpBreach[];
    } catch {
      out.errors.push(`HIBP: unreadable response for ${mask(email)}`);
      continue;
    }
    for (const b of breaches) out.findings.push(toFinding(email, b));
  }
  return out;
}

export function toFinding(email: string, b: HibpBreach): Finding {
  const classes = b.DataClasses ?? [];
  const parts = [
    b.BreachDate ? `Breached ${b.BreachDate}` : null,
    classes.length ? `Exposed: ${classes.join(", ")}` : null,
    b.IsSpamList ? "Spam list" : null,
    b.IsVerified === false ? "Unverified breach" : null,
  ].filter(Boolean);
  return {
    source: "hibp",
    identifier: email,
    title: b.Title || b.Name,
    url: b.Domain ? `https://${b.Domain}` : null,
    detail: parts.join(" · "),
    key: b.Name,
  };
}

/** One-line "what to do" for a breach, based on what was exposed. */
export function breachAdvice(detail: string, url: string | null): string {
  const site = url ? url.replace(/^https?:\/\//, "") : "that site";
  const d = detail.toLowerCase();
  const steps: string[] = [];
  if (d.includes("password")) steps.push(`change the password on ${site} and anywhere you reused it, turn on MFA`);
  if (d.includes("phone")) steps.push("expect SMS phishing; consider a carrier port-out PIN");
  if (d.includes("physical address") || d.includes("dates of birth")) steps.push("confirm credit freezes are on");
  if (d.includes("security questions")) steps.push("change security answers anywhere you used the same ones");
  if (steps.length === 0) steps.push("expect targeted phishing to this address; no other action needed");
  return steps.join("; ");
}
