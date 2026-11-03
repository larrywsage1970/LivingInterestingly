/**
 * GRID Ask: answers a question using only primary sources.
 *
 * Tools Claude can call:
 *   get_current_status        GRID's latest published status snapshot (what the board shows)
 *   fetch_primary_source(url) GET a page from an allowlisted primary-source domain
 *
 * Guardrails enforced in code (not just in the prompt):
 *   - Domain allowlist on every fetch, including each redirect hop.
 *   - Request timeouts, response size cap, max tool rounds.
 *   - No user data is sent anywhere except the question to the Anthropic API.
 *   - Sources used are returned with the answer and logged.
 */
import Anthropic from "@anthropic-ai/sdk";

export const ALLOWED_HOSTS = new Set([
  // Weather
  "api.weather.gov", "www.weather.gov", "forecast.weather.gov",
  // Emergency management
  "www.fema.gov", "www.ready.gov", "ema.ohio.gov",
  // Grid operator and reliability
  "www.pjm.com", "insidelines.pjm.com", "emergencyprocedures.pjm.com",
  "www.nerc.com", "www.eia.gov", "www.energy.gov",
  // Utility
  "www.firstenergycorp.com",
  // GRID's own published snapshot
  "larrywsage1970.github.io",
]);

const MAX_ROUNDS = 6;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CHARS = 12_000;
const USER_AGENT = "GRID-Ask/0.1 (contact: larrywsage@gmail.com)";

export const SYSTEM_PROMPT = `You answer questions for GRID, a status board for Stow, Ohio 44224 (Summit County; utility FirstEnergy / Ohio Edison; grid operator PJM).

Rules:
- Answer only from content you fetched with your tools in this conversation, or clearly labeled general knowledge ("General knowledge, not from a live source: ...").
- Start with get_current_status when the question is about current conditions. Use fetch_primary_source for anything else. You may only fetch these domains: ${[...ALLOWED_HOSTS].join(", ")}.
- Cite every factual claim inline with the source name and the time it was fetched or issued, e.g. "(NWS alerts, checked Nov 3, 11:09 AM EST)".
- Keep events and risk separate: say whether something is an issued alert, a forecast, an assessment, or a news post.
- If the sources do not answer the question, say so plainly and name which source to check. Do not speculate.
- Be neutral. No politics. Do not speculate about who is behind any viral or social media content.
- Keep the answer under about 170 words, plain sentences, no headings.
- If the question involves medical equipment that needs power, advise confirming a backup plan with FirstEnergy and the equipment provider.`;

export const TOOLS = [
  {
    name: "get_current_status",
    description:
      "Returns GRID's latest published status for Stow, OH: banner color and rule, each feed's state and last good time, and the items each feed reported (alerts, forecast periods, FEMA declarations, PJM notices, PJM demand). Use this first for questions about current conditions.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "fetch_primary_source",
    description:
      "HTTP GET a page or API response from an allowlisted primary-source domain and return its text (HTML stripped, truncated). Use for details the status snapshot does not include, e.g. an NWS alert's full text, a FEMA declaration page, a PJM Inside Lines post, or ready.gov guidance. Only these hosts are allowed: " +
      [...ALLOWED_HOSTS].join(", "),
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Full https URL on an allowlisted host." } },
      required: ["url"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "only https URLs are allowed" };
  if (u.username || u.password) return { ok: false, reason: "credentials in URL are not allowed" };
  if (u.port && u.port !== "443") return { ok: false, reason: "non-standard ports are not allowed" };
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    return { ok: false, reason: `host ${u.hostname} is not on the primary-source allowlist` };
  }
  return { ok: true, url: u.toString() };
}

function htmlToText(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** GET with the allowlist re-checked on every redirect hop. */
export async function safeFetch(rawUrl, fetchImpl = fetch) {
  let url = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const check = checkUrl(url);
    if (!check.ok) return { error: check.reason, url };
    const res = await fetchImpl(check.url, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json, application/json, text/html, application/xml;q=0.9, */*;q=0.5" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), check.url).toString();
      continue;
    }
    const type = (res.headers.get("content-type") || "").toLowerCase();
    const fetched_at = new Date().toISOString();
    if (type.includes("pdf")) {
      return { url: check.url, status: res.status, fetched_at, content_type: type,
               text: "This is a PDF. It cannot be read here; give the user the link." };
    }
    let body = await res.text();
    if (type.includes("html") || type.includes("xml")) body = htmlToText(body);
    const truncated = body.length > MAX_CHARS;
    return { url: check.url, status: res.status, fetched_at, content_type: type,
             truncated, text: body.slice(0, MAX_CHARS) };
  }
  return { error: "too many redirects", url: rawUrl };
}

/** Condense the published snapshot to what the model needs. */
export function condenseStatus(snapshot) {
  const cards = {};
  for (const [id, c] of Object.entries(snapshot.cards || {})) {
    cards[id] = {
      source: c.label, state: c.state, last_good_at: c.last_good_at, error: c.error || undefined,
      source_home: c.home_url,
      items: (c.items || []).map((i) => ({
        kind: i.kind, title: i.title, severity: i.severity ?? undefined, event: i.event,
        sender: i.sender, issued: i.issued || i.declared, starts: i.starts, ends: i.ends, url: i.url,
        excerpt: i.raw_excerpt ? i.raw_excerpt.slice(0, 300) : undefined,
      })),
    };
  }
  return { location: snapshot.location?.name, banner: snapshot.banner, cards };
}

async function runTool(name, input, ctx) {
  if (name === "get_current_status") {
    const r = await safeFetch(ctx.statusUrl, ctx.fetchImpl);
    if (r.error || r.status !== 200) return { error: r.error || `status snapshot HTTP ${r.status}` };
    ctx.sources.push({ name: "GRID status snapshot", url: ctx.statusUrl, fetched_at: r.fetched_at });
    try {
      return condenseStatus(JSON.parse(r.text));
    } catch {
      return { error: "status snapshot was not valid JSON" };
    }
  }
  if (name === "fetch_primary_source") {
    const url = typeof input?.url === "string" ? input.url : "";
    const r = await safeFetch(url, ctx.fetchImpl);
    if (!r.error) ctx.sources.push({ name: new URL(r.url).hostname, url: r.url, fetched_at: r.fetched_at });
    else ctx.refused.push({ url, reason: r.error });
    return r;
  }
  return { error: `unknown tool ${name}` };
}

/**
 * Answer one question. `client` is an Anthropic client (injected for tests).
 * Returns { answer, sources, refused, stop_reason }.
 */
export async function answer(question, { client, model, statusUrl, fetchImpl = fetch, now = new Date(), tz = "America/New_York" }) {
  const ctx = { statusUrl, fetchImpl, sources: [], refused: [] };
  const today = now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
  const messages = [{ role: "user", content: `Current date and time in Stow, OH: ${today}.\n\nQuestion: ${question}` }];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
      output_config: { effort: "medium" },
      // Server-side fallback on a safety decline; tell the user it is on.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      return { answer: "This question could not be answered. Check the primary sources linked on the board.",
               sources: ctx.sources, refused: ctx.refused, stop_reason: "refusal" };
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      const note = response.stop_reason === "max_tokens" ? " (Answer was cut off.)" : "";
      return { answer: (text || "No answer was produced.") + note, sources: ctx.sources,
               refused: ctx.refused, stop_reason: response.stop_reason };
    }
    messages.push({ role: "assistant", content: response.content });
    const results = await Promise.all(toolUses.map(async (t) => {
      let out;
      try {
        out = await runTool(t.name, t.input, ctx);
      } catch (e) {
        out = { error: `${e?.name || "Error"}: tool failed` };
      }
      return { type: "tool_result", tool_use_id: t.id, content: JSON.stringify(out), is_error: Boolean(out?.error) };
    }));
    messages.push({ role: "user", content: results });
  }
  return { answer: "I could not finish researching this. Check the primary sources linked on the board.",
           sources: ctx.sources, refused: ctx.refused, stop_reason: "max_rounds" };
}

export { Anthropic };
