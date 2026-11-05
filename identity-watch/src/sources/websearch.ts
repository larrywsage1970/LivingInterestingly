// Brave Search API sweep. Quoted queries per identifier, top 10 results each,
// ignore-list filtered. Never scrapes the result pages themselves.
import { type Env, type Identifiers, ignoreDomains, intVar, mask, sleep } from "../config.ts";
import { fetchWithBackoff } from "../http.ts";
import type { Finding, SourceResult } from "../types.ts";

interface Query {
  identifier: string;
  q: string;
}

export function buildQueries(ids: Identifiers): Query[] {
  const qs: Query[] = [];
  for (const e of ids.emails) qs.push({ identifier: e, q: `"${e}"` });
  for (const n of ids.names) {
    if (ids.city) qs.push({ identifier: n, q: `"${n}" "${ids.city}"` });
    qs.push({ identifier: n, q: `"${n}" address phone` });
  }
  for (const p of ids.phones) qs.push({ identifier: p, q: `"${p}"` });
  return qs;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isIgnored(host: string, ignore: string[]): boolean {
  return ignore.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Drop fragments and common tracking params so the same page fingerprints the same. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(p)) u.searchParams.delete(p);
    }
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

export async function sweepWeb(env: Env, ids: Identifiers): Promise<SourceResult> {
  const out: SourceResult = { findings: [], errors: [] };
  if (!env.BRAVE_API_KEY) {
    out.errors.push("Web: BRAVE_API_KEY is not set, web sweep skipped");
    return out;
  }
  const base = (env.BRAVE_BASE_URL ?? "https://api.search.brave.com").replace(/\/$/, "");
  const gapMs = intVar(env.BRAVE_DELAY_MS, 1100); // free tier: 1 query/second
  const ignore = ignoreDomains(env);
  const seen = new Set<string>();

  for (const [i, { identifier, q }] of buildQueries(ids).entries()) {
    if (i > 0) await sleep(gapMs);
    const url = `${base}/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&safesearch=off`;
    let res: Response;
    try {
      res = await fetchWithBackoff(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY },
      });
    } catch (e) {
      out.errors.push(`Web: network error on query ${i + 1} (${mask(identifier)}): ${(e as Error).message}`);
      continue;
    }
    if (!res.ok) {
      out.errors.push(`Web: HTTP ${res.status} on query ${i + 1} (${mask(identifier)})`);
      await res.body?.cancel();
      continue;
    }
    let results: BraveResult[] = [];
    try {
      const body = (await res.json()) as { web?: { results?: BraveResult[] } };
      results = body.web?.results ?? [];
    } catch {
      out.errors.push(`Web: unreadable response on query ${i + 1}`);
      continue;
    }
    for (const r of results.slice(0, 10)) {
      if (!r.url) continue;
      const host = hostOf(r.url);
      if (!host || isIgnored(host, ignore)) continue;
      const norm = normalizeUrl(r.url);
      const dedupe = `${identifier}|${norm}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.findings.push({
        source: "websearch",
        identifier,
        title: stripTags(r.title ?? host),
        url: norm,
        detail: stripTags(r.description ?? "").slice(0, 300),
        key: norm,
      });
    }
  }
  return out;
}

const stripTags = (s: string): string =>
  s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
