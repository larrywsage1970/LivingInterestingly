import { sleep } from "./config.ts";

/**
 * fetch with backoff on 429 / 5xx. Honors Retry-After (seconds). Caps the wait
 * so a bad header can't stall the cron run.
 */
export async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  { retries = 3, maxWaitMs = 30_000 }: { retries?: number; maxWaitMs?: number } = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) return res;
    const ra = Number.parseFloat(res.headers.get("retry-after") ?? "");
    const waitMs = Math.min(maxWaitMs, Number.isFinite(ra) ? ra * 1000 + 250 : 2000 * 2 ** attempt);
    await res.body?.cancel();
    await sleep(waitMs);
  }
}
