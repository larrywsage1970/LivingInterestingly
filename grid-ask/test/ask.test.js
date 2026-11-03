import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, checkUrl, safeFetch } from "../src/ask.js";
import worker from "../src/index.js";

const STATUS_URL = "https://larrywsage1970.github.io/LivingInterestingly/api/status.json";
const SNAPSHOT = {
  location: { name: "Stow, OH 44224" },
  banner: { color: "green", rule: "SYNTHETIC rule", computed_at: "2030-01-10T17:00:00+00:00" },
  cards: { nws_alerts: { label: "NWS alerts", state: "fresh", last_good_at: "2030-01-10T17:00:00+00:00",
                         home_url: "https://forecast.weather.gov/", items: [] } },
};

function fakeFetch(routes, seen = []) {
  return async (url, opts) => {
    seen.push(url);
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(r.body, { status: r.status || 200, headers: r.headers || { "content-type": "application/json" } });
  };
}

/** Scripted stand-in for client.beta.messages.create. */
function fakeClient(script, calls = []) {
  let i = 0;
  return { beta: { messages: { create: async (params) => { calls.push(structuredClone(params)); return script[i++]; } } } };
}

test("allowlist accepts primary sources and rejects everything else", () => {
  assert.ok(checkUrl("https://api.weather.gov/alerts/active?point=41,-81").ok);
  assert.ok(checkUrl("https://insidelines.pjm.com/feed/").ok);
  for (const bad of ["http://api.weather.gov/", "https://twitter.com/x", "https://api.weather.gov.evil.com/",
                     "https://user:pw@www.fema.gov/", "https://www.fema.gov:8443/", "not a url",
                     "https://news.example.com/grid-collapse"]) {
    assert.equal(checkUrl(bad).ok, false, bad);
  }
});

test("redirects are re-checked against the allowlist", async () => {
  const f = fakeFetch({
    "https://www.fema.gov/start": { status: 302, body: "", headers: { location: "https://evil.example.com/" } },
  });
  const r = await safeFetch("https://www.fema.gov/start", f);
  assert.match(r.error, /not on the primary-source allowlist/);
});

test("html is reduced to text and capped", async () => {
  const f = fakeFetch({ "https://www.ready.gov/power-outages": {
    body: "<html><script>x()</script><h1>Power Outages</h1><p>" + "a".repeat(20000) + "</p></html>",
    headers: { "content-type": "text/html" } } });
  const r = await safeFetch("https://www.ready.gov/power-outages", f);
  assert.ok(r.text.startsWith("Power Outages"));
  assert.ok(!r.text.includes("x()"));
  assert.equal(r.text.length, 12000);
  assert.equal(r.truncated, true);
});

test("tool loop: status, refused off-list fetch, then a cited answer", async () => {
  const calls = [];
  const client = fakeClient([
    { stop_reason: "tool_use", content: [
      { type: "tool_use", id: "t1", name: "get_current_status", input: {} },
      { type: "tool_use", id: "t2", name: "fetch_primary_source", input: { url: "https://social.example.com/viral" } },
    ] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "No active alerts (NWS alerts, checked Jan 10)." }] },
  ], calls);
  const out = await answer("Any alerts?", {
    client, model: "test-model", statusUrl: STATUS_URL,
    fetchImpl: fakeFetch({ [STATUS_URL]: { body: JSON.stringify(SNAPSHOT) } }),
    now: new Date("2030-01-10T17:00:00Z"),
  });
  assert.equal(out.answer, "No active alerts (NWS alerts, checked Jan 10).");
  assert.deepEqual(out.sources.map((s) => s.name), ["GRID status snapshot"]);
  assert.equal(out.refused[0].url, "https://social.example.com/viral");

  // Second request carries both tool results in ONE user message; the refused one is an error.
  const results = calls[1].messages.at(-1).content;
  assert.equal(results.length, 2);
  assert.equal(results[0].is_error, false);
  assert.equal(results[1].is_error, true);
  assert.match(results[1].content, /allowlist/);
  // Model comes from config, fallbacks are on, date is in the question.
  assert.equal(calls[0].model, "test-model");
  assert.equal(calls[0].fallbacks, "default");
  assert.deepEqual(calls[0].betas, ["server-side-fallback-2026-07-01"]);
  assert.match(calls[0].messages[0].content, /January 10, 2030/);
});

test("refusal stop reason returns a safe message", async () => {
  const client = fakeClient([{ stop_reason: "refusal", content: [] }]);
  const out = await answer("x", { client, model: "m", statusUrl: STATUS_URL, fetchImpl: fakeFetch({}) });
  assert.equal(out.stop_reason, "refusal");
  assert.match(out.answer, /could not be answered/);
});

test("loop stops after max rounds", async () => {
  const loop = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "get_current_status", input: {} }] };
  const client = fakeClient(Array(10).fill(loop));
  const out = await answer("x", { client, model: "m", statusUrl: STATUS_URL,
                                  fetchImpl: fakeFetch({ [STATUS_URL]: { body: JSON.stringify(SNAPSHOT) } }) });
  assert.equal(out.stop_reason, "max_rounds");
});

const env = { ASK_PASSCODE: "correct horse", ALLOWED_ORIGIN: "https://larrywsage1970.github.io",
              ANTHROPIC_MODEL: "m", STATUS_URL };

test("worker: wrong passcode is 401 and never calls the model", async () => {
  const res = await worker.fetch(new Request("https://w/ask", {
    method: "POST", headers: { "X-GRID-Passcode": "nope", "Content-Type": "application/json" },
    body: JSON.stringify({ question: "hi" }) }), env);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://larrywsage1970.github.io");
});

test("worker: missing API key is 503, long question is 400, preflight is 204", async () => {
  const ask = (q) => worker.fetch(new Request("https://w/ask", {
    method: "POST", headers: { "X-GRID-Passcode": "correct horse" }, body: JSON.stringify({ question: q }) }), env);
  assert.equal((await ask("hi")).status, 503);
  assert.equal((await ask("x".repeat(501))).status, 400);
  const pre = await worker.fetch(new Request("https://w/ask", { method: "OPTIONS" }), env);
  assert.equal(pre.status, 204);
});
