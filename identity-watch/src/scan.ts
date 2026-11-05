// One run: gather sources for this kind, diff against D1, email, record the run.
import { dueBrokers, flagListedFromFindings, seedBrokers } from "./brokers.ts";
import { type Env, flag, loadIdentifiers, today } from "./config.ts";
import { insertNew } from "./diff.ts";
import { sendReport } from "./mail.ts";
import { buildReport } from "./report.ts";
import { checkHibp } from "./sources/hibp.ts";
import { checkLeakIndex } from "./sources/leakindex.ts";
import { sweepWeb } from "./sources/websearch.ts";
import type { BrokerRow, Finding, RunKind, SourceResult, StoredFinding } from "./types.ts";

export interface RunSummary {
  runId: number;
  kind: RunKind;
  newFindings: number;
  brokersDue: number;
  errors: string[];
  subject: string;
}

export async function runScan(env: Env, kind: RunKind, now = new Date()): Promise<RunSummary> {
  const startedIso = now.toISOString();
  const day = today(now);
  const errors: string[] = [];

  const run = await env.DB.prepare("INSERT INTO runs (started, kind) VALUES (?, ?) RETURNING id")
    .bind(startedIso, kind)
    .first<{ id: number }>();
  const runId = run?.id ?? 0;

  let fresh: StoredFinding[] = [];
  let brokers: BrokerRow[] = [];
  try {
    const ids = loadIdentifiers(env);
    const full = kind !== "weekly";

    const jobs: Promise<SourceResult>[] = [checkHibp(env, ids.emails)];
    if (full && flag(env.WEBSEARCH_ENABLED, true)) jobs.push(sweepWeb(env, ids));
    if (full && flag(env.LEAKINDEX_ENABLED, false)) jobs.push(checkLeakIndex(env, ids));

    const all: Finding[] = [];
    for (const r of await Promise.allSettled(jobs)) {
      if (r.status === "fulfilled") {
        all.push(...r.value.findings);
        errors.push(...r.value.errors);
      } else {
        errors.push(`Source failed: ${(r.reason as Error)?.message ?? r.reason}`);
      }
    }

    fresh = await insertNew(env.DB, all, startedIso);

    if (full) {
      await seedBrokers(env.DB);
      await flagListedFromFindings(env.DB, fresh, day);
      brokers = await dueBrokers(env.DB, day);
    }
  } catch (e) {
    errors.push(`Run failed: ${(e as Error).message}`);
  }

  const report = buildReport({ kind, date: day, findings: fresh, brokersDue: brokers, errors, dashboardUrl: env.DASHBOARD_URL });
  try {
    await sendReport(env, report);
  } catch (e) {
    errors.push(`Email failed: ${(e as Error).message}`);
  }

  await env.DB.prepare("UPDATE runs SET new_findings = ?, errors = ? WHERE id = ?")
    .bind(fresh.length, errors.length ? JSON.stringify(errors) : null, runId)
    .run();

  // Counts only. No identifiers or finding contents in logs.
  console.log(`identity-watch run ${runId} kind=${kind} new=${fresh.length} brokersDue=${brokers.length} errors=${errors.length}`);
  return { runId, kind, newFindings: fresh.length, brokersDue: brokers.length, errors, subject: report.subject };
}
