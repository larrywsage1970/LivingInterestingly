// Send the report via Resend. DRY_RUN=true (local only) prints instead.
import { type Env, flag } from "./config.ts";
import type { Report } from "./report.ts";

export async function sendReport(env: Env, report: Report): Promise<void> {
  if (flag(env.DRY_RUN)) {
    console.log(`[DRY_RUN] Subject: ${report.subject}\n${report.text}`);
    return;
  }
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  if (!env.REPORT_TO) throw new Error("REPORT_TO is not set");

  const base = (env.RESEND_BASE_URL ?? "https://api.resend.com").replace(/\/$/, "");
  const res = await fetch(`${base}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.REPORT_FROM || "Identity Watch <onboarding@resend.dev>",
      to: [env.REPORT_TO],
      subject: report.subject,
      text: report.text,
      html: report.html,
    }),
  });
  if (!res.ok) {
    // Resend error bodies describe the problem, not our secrets. Cap the length anyway.
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Resend HTTP ${res.status}: ${body}`);
  }
}
