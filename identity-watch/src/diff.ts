// Fingerprint findings and keep only ones D1 has never seen.
import type { Finding, StoredFinding } from "./types.ts";

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256(source|identifier|url-or-breach). Identifier lowercased so case changes don't re-alert. */
export const fingerprint = (f: Finding): Promise<string> =>
  sha256Hex(`${f.source}|${f.identifier.toLowerCase()}|${f.key}`);

const CHUNK = 50;

/**
 * INSERT OR IGNORE each finding on its fingerprint. Returns only the rows that
 * were actually inserted, i.e. new since the last run.
 */
export async function insertNew(db: D1Database, findings: Finding[], nowIso: string): Promise<StoredFinding[]> {
  const fresh: StoredFinding[] = [];
  const withFp = await Promise.all(findings.map(async (f) => ({ f, fp: await fingerprint(f) })));
  // Same fingerprint twice in one run: keep the first.
  const unique = [...new Map(withFp.map((x) => [x.fp, x])).values()];

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const stmts = chunk.map(({ f, fp }) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO findings (source, identifier, title, url, detail, fingerprint, first_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(f.source, f.identifier, f.title, f.url, f.detail, fp, nowIso),
    );
    const results = await db.batch<{ id: number }>(stmts);
    results.forEach((r, j) => {
      const row = r.results?.[0];
      if (row) fresh.push({ ...chunk[j].f, id: row.id, fingerprint: chunk[j].fp, first_seen: nowIso });
    });
  }
  return fresh;
}
