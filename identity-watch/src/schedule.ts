import type { RunKind } from "./types.ts";

/** Must match the quarterly entry in wrangler.toml [triggers].crons. */
export const QUARTERLY_CRON = "0 13 1 */3 *";

export const kindForCron = (cron: string): RunKind => (cron === QUARTERLY_CRON ? "quarterly" : "weekly");
