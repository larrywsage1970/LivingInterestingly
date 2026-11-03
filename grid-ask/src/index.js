/**
 * GRID Ask - Cloudflare Worker.
 *
 * POST /ask  { "question": "..." }  header X-GRID-Passcode: <passcode>
 *   -> { answer, sources: [{name, url, fetched_at}], refused: [...] }
 * GET  /health -> { ok: true }
 *
 * Secrets (Cloudflare Secrets Store, see wrangler.toml): ANTHROPIC_API_KEY, ASK_PASSCODE.
 * Vars: ANTHROPIC_MODEL, STATUS_URL, ALLOWED_ORIGIN.
 */
import { Anthropic, answer } from "./ask.js";

const MAX_QUESTION = 500;
const PER_IP_PER_HOUR = 12;
const hits = new Map(); // best-effort per-isolate limiter; the passcode + Anthropic spend cap are the real limits

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-GRID-Passcode",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(env) },
  });
}

async function secret(binding) {
  if (!binding) return "";
  return typeof binding === "string" ? binding : (await binding.get()) || "";
}

function sameSecret(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function limited(ip, now = Date.now()) {
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > PER_IP_PER_HOUR;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    if (url.pathname === "/health") return json({ ok: true }, 200, env);
    if (url.pathname !== "/ask" || request.method !== "POST") return json({ error: "not found" }, 404, env);

    const passcode = await secret(env.ASK_PASSCODE);
    if (!passcode || !sameSecret(request.headers.get("X-GRID-Passcode") || "", passcode)) {
      return json({ error: "Wrong or missing passcode." }, 401, env);
    }
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (limited(ip)) return json({ error: "Too many questions this hour. Try again later." }, 429, env);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Send JSON: {\"question\": \"...\"}" }, 400, env);
    }
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "Question is empty." }, 400, env);
    if (question.length > MAX_QUESTION) return json({ error: `Keep questions under ${MAX_QUESTION} characters.` }, 400, env);

    const apiKey = await secret(env.ANTHROPIC_API_KEY);
    if (!apiKey || !env.ANTHROPIC_MODEL) return json({ error: "Ask is not configured yet." }, 503, env);

    try {
      const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
      const out = await answer(question, { client, model: env.ANTHROPIC_MODEL, statusUrl: env.STATUS_URL });
      // Log which sources each answer used (not the user's IP).
      console.log(JSON.stringify({ event: "ask", stop: out.stop_reason, sources: out.sources.map((s) => s.url), refused: out.refused }));
      return json(out, 200, env);
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return json({ error: "The answer service is busy. Try again in a minute." }, 503, env);
      if (e instanceof Anthropic.AuthenticationError) return json({ error: "Ask is misconfigured (API key)." }, 503, env);
      if (e instanceof Anthropic.APIError) return json({ error: `The answer service returned an error (${e.status}).` }, 502, env);
      return json({ error: "Something went wrong answering that." }, 500, env);
    }
  },
};
