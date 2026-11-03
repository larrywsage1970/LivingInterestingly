import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker, { maybeRun } from "../src/index.js";

const env = { GH_OWNER: "o", GH_REPO: "r", GH_WORKFLOW: "w.yml", GH_REF: "main",
              ALLOWED_ORIGIN: "https://larrywsage1970.github.io", MIN_GAP_SECONDS: "180",
              GITHUB_TOKEN: "TEST-TOKEN" };
let calls, runs, dispatchStatus;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = []; runs = []; dispatchStatus = 204;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers, body: init.body });
    if (url.endsWith("/runs?per_page=1")) return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
    if (url.endsWith("/dispatches")) return new Response(null, { status: dispatchStatus });
    return new Response("nope", { status: 404 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const NOW = Date.parse("2030-01-10T17:00:00Z");

test("starts a run when the last one is finished and old enough", async () => {
  runs = [{ status: "completed", created_at: "2030-01-10T16:40:00Z" }];
  const r = await maybeRun(env, "TEST-TOKEN", NOW);
  assert.equal(r.action, "started");
  const d = calls.find((c) => c.url.endsWith("/dispatches"));
  assert.equal(d.url, "https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches");
  assert.deepEqual(JSON.parse(d.body), { ref: "main" });
  assert.equal(d.headers.Authorization, "Bearer TEST-TOKEN");
});

test("does not start while a run is queued or in progress", async () => {
  runs = [{ status: "in_progress", created_at: "2030-01-10T16:59:00Z", run_started_at: "2030-01-10T16:59:05Z" }];
  assert.equal((await maybeRun(env, "T", NOW)).action, "already_running");
  assert.ok(!calls.some((c) => c.url.endsWith("/dispatches")));
});

test("does not start again within the minimum gap", async () => {
  runs = [{ status: "completed", created_at: "2030-01-10T16:58:30Z" }];
  assert.equal((await maybeRun(env, "T", NOW)).action, "recent");
});

test("first ever run (no history) starts", async () => {
  assert.equal((await maybeRun(env, "T", NOW)).action, "started");
});

test("POST /refresh returns the decision with CORS; token never in the response", async () => {
  runs = [{ status: "completed", created_at: "2000-01-01T00:00:00Z" }];
  const res = await worker.fetch(new Request("https://w/refresh", { method: "POST" }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://larrywsage1970.github.io");
  const text = await res.text();
  assert.equal(JSON.parse(text).action, "started");
  assert.ok(!text.includes("TEST-TOKEN"));
});

test("GitHub failure is a 502 without details; missing token is 503", async () => {
  dispatchStatus = 403;
  const res = await worker.fetch(new Request("https://w/refresh", { method: "POST" }), env);
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes("TEST-TOKEN"));
  const res2 = await worker.fetch(new Request("https://w/refresh", { method: "POST" }), { ...env, GITHUB_TOKEN: "" });
  assert.equal(res2.status, 503);
});

test("GET /refresh is 404, OPTIONS is 204, /health ok", async () => {
  assert.equal((await worker.fetch(new Request("https://w/refresh"), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://w/refresh", { method: "OPTIONS" }), env)).status, 204);
  assert.equal((await worker.fetch(new Request("https://w/health"), env)).status, 200);
});

test("cron uses the same rules", async () => {
  runs = [{ status: "completed", created_at: "2000-01-01T00:00:00Z" }];
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.ok(calls.some((c) => c.url.endsWith("/dispatches")));
});
