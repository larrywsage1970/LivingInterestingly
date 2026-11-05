// Identity Watch Worker entry point.
//   scheduled(): weekly HIBP check, quarterly full scan (HIBP + web + leak index + brokers)
//   fetch():     /dashboard, POST /findings/:id, POST /brokers/:id, POST /run
//                Every HTTP route requires a valid Cloudflare Access JWT. No Access config = 404.
import { verifyAccess } from "./access.ts";
import type { Env } from "./config.ts";
import { SECURITY_HEADERS, renderDashboard, updateBroker, updateFinding } from "./dashboard.ts";
import { runScan } from "./scan.ts";
import { kindForCron } from "./schedule.ts";

// NOTE: export nothing else from this file. workerd treats every named export
// of the entry module as a handler and refuses to start.

const notFound = (): Response => new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
const back = (msg: string): Response =>
  new Response(null, { status: 303, headers: { location: `/dashboard?msg=${encodeURIComponent(msg)}`, ...SECURITY_HEADERS } });

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScan(env, kindForCron(event.cron)));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    let who;
    try {
      who = await verifyAccess(req, env);
    } catch {
      who = null;
    }
    if (!who) return notFound(); // don't reveal that anything lives here

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      return renderDashboard(env, url, who.email ?? who.sub ?? "Access user");
    }

    if (req.method !== "POST") return notFound();
    // CSRF guard: forms must come from this origin.
    const origin = req.headers.get("origin");
    if (!origin || origin !== url.origin) return new Response("Bad origin", { status: 403, headers: SECURITY_HEADERS });

    if (url.pathname === "/run") {
      const s = await runScan(env, "manual");
      return back(`Run ${s.runId}: ${s.newFindings} new, ${s.brokersDue} brokers due, ${s.errors.length} errors. Report emailed: "${s.subject}"`);
    }
    const m = /^\/(findings|brokers)\/(\d+)$/.exec(url.pathname);
    if (m) {
      const form = await req.formData();
      const id = Number(m[2]);
      const msg = m[1] === "findings" ? await updateFinding(env, id, form) : await updateBroker(env, id, form);
      return back(msg);
    }
    return notFound();
  },
} satisfies ExportedHandler<Env>;
