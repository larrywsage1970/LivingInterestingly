// Intelligence X leak/dark-web index lookup. Feature-flagged OFF by default
// (LEAKINDEX_ENABLED). Stores the leak's name, bucket, and date only. It never
// downloads or previews leaked file contents, so no credentials can land here.
import { type Env, type Identifiers, mask, sleep } from "../config.ts";
import { fetchWithBackoff } from "../http.ts";
import type { Finding, SourceResult } from "../types.ts";

interface IntelxRecord {
  systemid: string;
  name?: string;
  date?: string;
  bucket?: string;
  bucketh?: string;
}

const POLL_TRIES = 5;
const POLL_GAP_MS = 2000;

export async function checkLeakIndex(env: Env, ids: Identifiers): Promise<SourceResult> {
  const out: SourceResult = { findings: [], errors: [] };
  if (!env.INTELX_API_KEY) {
    out.errors.push("Leak index: enabled but INTELX_API_KEY is not set, skipped");
    return out;
  }
  // Free keys use https://free.intelx.io; paid keys use https://2.intelx.io.
  const base = (env.INTELX_BASE_URL ?? "https://2.intelx.io").replace(/\/$/, "");
  const headers = { "x-key": env.INTELX_API_KEY, "content-type": "application/json", "user-agent": "identity-watch" };

  for (const term of [...ids.emails, ...ids.phones]) {
    try {
      const start = await fetchWithBackoff(`${base}/intelligent/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({ term, maxresults: 50, media: 0, sort: 4, terminate: [], timeout: 5 }),
      });
      if (!start.ok) {
        out.errors.push(`Leak index: HTTP ${start.status} starting search for ${mask(term)}`);
        await start.body?.cancel();
        continue;
      }
      const { id } = (await start.json()) as { id?: string };
      if (!id) {
        out.errors.push(`Leak index: no search id for ${mask(term)}`);
        continue;
      }
      const records: IntelxRecord[] = [];
      for (let t = 0; t < POLL_TRIES; t++) {
        const r = await fetchWithBackoff(`${base}/intelligent/search/result?id=${encodeURIComponent(id)}&limit=50`, { headers });
        if (!r.ok) {
          out.errors.push(`Leak index: HTTP ${r.status} reading results for ${mask(term)}`);
          await r.body?.cancel();
          break;
        }
        // status: 0 = results, 1 = done, 2 = id not found, 3 = no results yet
        const body = (await r.json()) as { status?: number; records?: IntelxRecord[] };
        records.push(...(body.records ?? []));
        if (body.status === 1 || body.status === 2) break;
        await sleep(POLL_GAP_MS);
      }
      await fetch(`${base}/intelligent/search/terminate?id=${encodeURIComponent(id)}`, { headers }).catch(() => {});
      for (const rec of records) out.findings.push(toFinding(term, rec));
    } catch (e) {
      out.errors.push(`Leak index: error for ${mask(term)}: ${(e as Error).message}`);
    }
  }
  return out;
}

function toFinding(term: string, rec: IntelxRecord): Finding {
  return {
    source: "leakindex",
    identifier: term,
    // Leak/file name only (e.g. "Collection #1"). Capped to keep it a label, not content.
    title: (rec.name || "Unnamed leak record").slice(0, 120),
    url: null,
    detail: [rec.bucketh || rec.bucket, rec.date ? `dated ${rec.date.slice(0, 10)}` : null].filter(Boolean).join(" · "),
    key: rec.systemid,
  };
}
