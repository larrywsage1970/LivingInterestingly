// Identity Watch Worker entry point.
//   scheduled(): weekly HIBP check, quarterly full scan (HIBP + web + leak index + brokers)
//   fetch():     dashboard + forms. Every HTTP route requires a valid Cloudflare
//                Access JWT for this app. No Access config = 404 for everything.
import { verifyAccess } from "./access.ts";
import type { Env } from "./config.ts";
import {
  addBroker,
  brokerFormSubmitted,
  deleteDismissed,
  deleteFinding,
  removeBroker,
  renderDashboard,
  renderRequestForm,
  SECURITY_HEADERS,
  submitRequest,
  updateBroker,
  updateFinding,
} from "./dashboard.ts";
import { setRequestStatus } from "./removal.ts";
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
    const path = url.pathname;

    let who;
    try {
      who = await verifyAccess(req, env);
    } catch {
      who = null;
    }
    if (!who) return notFound(); // don't reveal that anything lives here
    const name = who.email ?? who.sub ?? "Access user";

    if (req.method === "GET") {
      if (path === "/" || path === "/dashboard") return renderDashboard(env, url, name);
      const g = /^\/(brokers|findings)\/(\d+)\/request$/.exec(path);
      if (g) return renderRequestForm(env, g[1] === "brokers" ? "broker" : "finding", Number(g[2]), name);
      return notFound();
    }

    if (req.method !== "POST") return notFound();
    // CSRF guard: forms must come from this origin.
    const origin = req.headers.get("origin");
    if (!origin || origin !== url.origin) return new Response("Bad origin", { status: 403, headers: SECURITY_HEADERS });

    if (path === "/run") {
      const s = await runScan(env, "manual");
      return back(`Run ${s.runId}: ${s.newFindings} new, ${s.brokersDue} brokers due, ${s.errors.length} errors. Report emailed: "${s.subject}"`);
    }
    if (path === "/findings/delete-dismissed") return back(await deleteDismissed(env));
    if (path === "/brokers/new") return back(await addBroker(env, await req.formData()));

    let m: RegExpExecArray | null;
    if ((m = /^\/findings\/(\d+)$/.exec(path))) return back(await updateFinding(env, Number(m[1]), await req.formData()));
    if ((m = /^\/findings\/(\d+)\/delete$/.exec(path))) return back(await deleteFinding(env, Number(m[1])));
    if ((m = /^\/brokers\/(\d+)$/.exec(path))) return back(await updateBroker(env, Number(m[1]), await req.formData()));
    if ((m = /^\/brokers\/(\d+)\/delete$/.exec(path))) return back(await removeBroker(env, Number(m[1]), true));
    if ((m = /^\/brokers\/(\d+)\/restore$/.exec(path))) return back(await removeBroker(env, Number(m[1]), false));
    if ((m = /^\/brokers\/(\d+)\/form-submitted$/.exec(path))) return back(await brokerFormSubmitted(env, Number(m[1])));
    if ((m = /^\/requests\/(\d+)\/(confirmed|failed|sent)$/.exec(path))) {
      return back(await setRequestStatus(env.DB, Number(m[1]), m[2]));
    }
    if ((m = /^\/(brokers|findings)\/(\d+)\/request$/.exec(path))) {
      const type = m[1] === "brokers" ? "broker" : "finding";
      const r = await submitRequest(env, type, Number(m[2]), await req.formData());
      // On failure, re-show the form with your edits and the reason.
      return r.ok ? back(r.message) : renderRequestForm(env, type, Number(m[2]), name, r.message, r.draft);
    }
    return notFound();
  },
} satisfies ExportedHandler<Env>;
