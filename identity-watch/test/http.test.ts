// HTTP surface: Access JWT verification (fail closed), CSRF guard, dashboard edits.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { _resetAccessCache } from "../src/access.ts";
import { seedBrokers } from "../src/brokers.ts";
import worker from "../src/index.ts";
import { baseEnv, json, makeDb, mockFetch, rawDb } from "./helpers.ts";

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

let keys: CryptoKeyPair;
let restore = () => {};

beforeEach(async () => {
  _resetAccessCache();
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
  restore = mockFetch({ [`https://${TEAM}/cdn-cgi/access/certs`]: () => json({ keys: [jwk] }) }).restore;
});
afterEach(() => restore());

async function jwt(claims: Record<string, unknown> = {}, kid = "k1") {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: "RS256", kid });
  const p = enc({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, email: "me@example.com", ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}

const envWith = (over = {}) => baseEnv(makeDb(), { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...over });
const ORIGIN = "https://iw.example.com";
const get = (token?: string, path = "/dashboard") =>
  new Request(`${ORIGIN}${path}`, { headers: token ? { "cf-access-jwt-assertion": token } : {} });

test("no Access config: every route 404s", async () => {
  const res = await worker.fetch(get(await jwt()), baseEnv(makeDb()));
  assert.equal(res.status, 404);
});

test("valid Access token renders dashboard; bad tokens are refused", async () => {
  const env = envWith();
  const ok = await worker.fetch(get(await jwt()), env);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Signed in as me@example\.com/);
  assert.equal(ok.headers.get("x-frame-options"), "DENY");

  // via cookie too
  const viaCookie = await worker.fetch(new Request(`${ORIGIN}/dashboard`, { headers: { cookie: `x=1; CF_Authorization=${await jwt()}` } }), env);
  assert.equal(viaCookie.status, 200);

  for (const bad of [
    undefined,
    await jwt({ aud: ["other-app"] }),
    await jwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
    await jwt({ iss: "https://evil.cloudflareaccess.com" }),
    await jwt({}, "unknown-kid"),
    (await jwt()).replace(/\.[^.]+$/, ".AAAA"),
    "not.a.jwt",
  ]) {
    assert.equal((await worker.fetch(get(bad), env)).status, 404, `token should fail: ${bad?.slice(0, 20)}`);
  }
});

test("POST requires same origin; broker edit sets next_check", async () => {
  const env = envWith();
  await seedBrokers(env.DB);
  const token = await jwt();
  const form = new URLSearchParams({ listed: "1", optout_submitted: "2026-11-05", optout_url: "https://www.spokeo.com/optout", notes: "done" });

  const csrf = await worker.fetch(
    new Request(`${ORIGIN}/brokers/1`, { method: "POST", body: form, headers: { "cf-access-jwt-assertion": token, origin: "https://evil.example" } }),
    env,
  );
  assert.equal(csrf.status, 403);

  const res = await worker.fetch(
    new Request(`${ORIGIN}/brokers/1`, { method: "POST", body: form, headers: { "cf-access-jwt-assertion": token, origin: ORIGIN } }),
    env,
  );
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get("location")!), /next check 2027-02-03/);
  const row = rawDb(env.DB).prepare("SELECT listed, optout_submitted, next_check, notes FROM brokers WHERE id=1").get();
  assert.deepEqual({ ...row }, { listed: 1, optout_submitted: "2026-11-05", next_check: "2027-02-03", notes: "done" });

  const bad = await worker.fetch(
    new Request(`${ORIGIN}/brokers/1`, {
      method: "POST",
      body: new URLSearchParams({ listed: "1", optout_url: "javascript:alert(1)" }),
      headers: { "cf-access-jwt-assertion": token, origin: ORIGIN },
    }),
    env,
  );
  assert.match(decodeURIComponent(bad.headers.get("location")!), /must start with https/);
});

test("finding status update validates input", async () => {
  const env = envWith();
  rawDb(env.DB).exec("INSERT INTO findings (source, identifier, fingerprint, first_seen) VALUES ('hibp','a@x.com','fp1','2026-11-05')");
  const token = await jwt();
  const post = (status: string) =>
    worker.fetch(
      new Request(`${ORIGIN}/findings/1`, { method: "POST", body: new URLSearchParams({ status }), headers: { "cf-access-jwt-assertion": token, origin: ORIGIN } }),
      env,
    );
  assert.match(decodeURIComponent((await post("dismissed")).headers.get("location")!), /marked dismissed/);
  assert.match(decodeURIComponent((await post("hacked")).headers.get("location")!), /Invalid status/);
  assert.equal((rawDb(env.DB).prepare("SELECT status FROM findings").get() as { status: string }).status, "dismissed");
});

// ------------------------------------------------------------ delete + removal

import { runScan } from "../src/scan.ts";
import type { Call } from "./helpers.ts";

async function authed(env: ReturnType<typeof envWith>, path: string, form?: Record<string, string>) {
  const token = await jwt();
  const init: RequestInit = form
    ? { method: "POST", body: new URLSearchParams(form), headers: { "cf-access-jwt-assertion": token, origin: ORIGIN } }
    : { headers: { "cf-access-jwt-assertion": token } };
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}
const msgOf = (r: Response) => decodeURIComponent(r.headers.get("location") ?? "");
const q = (env: ReturnType<typeof envWith>, sql: string) => rawDb(env.DB).prepare(sql).all().map((r) => ({ ...r }));

/** Re-mock fetch keeping the Access certs route, adding Resend + HIBP(no breaches). */
async function mockMail(sent: Call[], hibp: Record<string, unknown[]> = {}) {
  restore();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
  restore = mockFetch({
    [`https://${TEAM}/cdn-cgi/access/certs`]: () => json({ keys: [jwk] }),
    "https://hibp.test/api/v3/breachedaccount/": (req) => {
      const e = decodeURIComponent(new URL(req.url).pathname.split("/").pop()!);
      return hibp[e] ? json(hibp[e]) : new Response(null, { status: 404 });
    },
    "https://brave.test/": () => json({ web: { results: [] } }),
    "https://resend.test/emails": async (req) => {
      sent.push({ method: req.method, url: req.url, headers: req.headers, body: await req.text() });
      return json({ id: "m" });
    },
  }).restore;
}

test("delete finding forgets it (re-alerts); dismiss keeps it quiet; bulk delete dismissed", async () => {
  const env = envWith();
  const sent: Call[] = [];
  await mockMail(sent, { "test.person@example.com": [{ Name: "Acme", DataClasses: ["Email addresses"] }, { Name: "Beta" }] });
  assert.equal((await runScan(env, "weekly")).newFindings, 2);

  const [acme, beta] = q(env, "SELECT id FROM findings ORDER BY id") as { id: number }[];
  assert.match(msgOf(await authed(env, `/findings/${acme.id}/delete`, {})), /deleted/);
  assert.match(msgOf(await authed(env, `/findings/${beta.id}`, { status: "dismissed" })), /dismissed/);

  const r2 = await runScan(env, "weekly");
  assert.equal(r2.newFindings, 1, "deleted Acme comes back as new; dismissed Beta stays quiet");
  assert.match(JSON.parse(sent[1].body).text, /Acme/);

  assert.match(msgOf(await authed(env, "/findings/delete-dismissed", {})), /Deleted 1 dismissed/);
  assert.deepEqual(q(env, "SELECT title FROM findings"), [{ title: "Acme" }]);
});

test("removed broker stays removed across seeding, can be restored; add broker validates", async () => {
  const env = envWith();
  const sent: Call[] = [];
  await mockMail(sent);
  await runScan(env, "manual");
  const spokeo = q(env, "SELECT id FROM brokers WHERE name='Spokeo'")[0] as { id: number };

  assert.match(msgOf(await authed(env, `/brokers/${spokeo.id}/delete`, {})), /removed/);
  const r = await runScan(env, "manual");
  assert.equal(r.brokersDue, 15);
  assert.deepEqual(q(env, "SELECT removed FROM brokers WHERE name='Spokeo'"), [{ removed: 1 }]);
  assert.doesNotMatch(JSON.parse(sent[1].body).text, /Spokeo/);

  assert.match(msgOf(await authed(env, `/brokers/${spokeo.id}/restore`, {})), /restored/);
  assert.equal((await runScan(env, "manual")).brokersDue, 16);

  assert.match(msgOf(await authed(env, "/brokers/new", { name: "Example People", site: "https://www.ExamplePeople.com/x" })), /added/);
  assert.deepEqual(q(env, "SELECT site FROM brokers WHERE name='Example People'"), [{ site: "examplepeople.com" }]);
  assert.match(msgOf(await authed(env, "/brokers/new", { name: "Bad", site: "not a domain" })), /domain like/);
  assert.match(msgOf(await authed(env, "/brokers/new", { name: "Bad", site: "bad.com", optout_email: "nope" })), /not a valid/);
});

test("seeding fills blank broker emails but never overwrites yours", async () => {
  const env = envWith();
  const sent: Call[] = [];
  await mockMail(sent);
  rawDb(env.DB).exec("INSERT INTO brokers (name, site) VALUES ('MyLife','mylife.com'), ('Whitepages','whitepages.com')");
  rawDb(env.DB).exec("UPDATE brokers SET optout_email='mine@whitepages.example' WHERE name='Whitepages'");
  await runScan(env, "manual");
  assert.deepEqual(q(env, "SELECT name, optout_email FROM brokers WHERE name IN ('MyLife','Whitepages') ORDER BY name"), [
    { name: "MyLife", optout_email: "membersupport@mylife.com" },
    { name: "Whitepages", optout_email: "mine@whitepages.example" },
  ]);
});

test("broker email request: draft, refuse without REQUEST_FROM, send, log, schedule re-check", async () => {
  const sent: Call[] = [];
  const envOff = envWith();
  await mockMail(sent);
  await runScan(envOff, "manual");
  const ml = q(envOff, "SELECT id FROM brokers WHERE name='MyLife'")[0] as { id: number };
  // a web finding on mylife.com becomes the profile URL in the draft
  rawDb(envOff.DB).exec(
    "INSERT INTO findings (source, identifier, url, title, fingerprint, first_seen) VALUES ('websearch','Test Person','https://www.mylife.com/test-person/123','MyLife','fpml','2026-11-05')",
  );

  const form = await (await authed(envOff, `/brokers/${ml.id}/request`)).text();
  assert.match(form, /value="membersupport@mylife\.com"/);
  assert.match(form, /Name: Test Person/);
  assert.match(form, /Location: Springfield, OH/);
  assert.match(form, /https:\/\/www\.mylife\.com\/test-person\/123/);
  assert.match(form, /Sending is off/);
  assert.match(form, /<button disabled>/);

  const draft = { to: "membersupport@mylife.com", subject: "Personal data deletion and opt-out request", body: "Please delete me.\nTest Person" };
  const refused = await authed(envOff, `/brokers/${ml.id}/request`, draft);
  assert.equal(refused.status, 200);
  assert.match(await refused.text(), /Set REQUEST_FROM/);
  const reportsBefore = sent.length; // just the scan report; the refused request sent nothing
  assert.equal(reportsBefore, 1);

  const env = { ...envOff, REQUEST_FROM: "Removal <privacy@mydomain.example>" };
  const ok = await authed(env, `/brokers/${ml.id}/request`, draft);
  assert.equal(ok.status, 303);
  assert.match(msgOf(ok), /Request sent to membersupport@mylife\.com\. Re-check on \d{4}-\d{2}-\d{2}/);
  assert.equal(sent.length, reportsBefore + 1);
  const mail = JSON.parse(sent.at(-1)!.body);
  assert.deepEqual(
    { from: mail.from, to: mail.to, reply_to: mail.reply_to, bcc: mail.bcc, text: mail.text },
    { from: "Removal <privacy@mydomain.example>", to: ["membersupport@mylife.com"], reply_to: "me@example.com", bcc: ["me@example.com"], text: draft.body },
  );
  const [req] = q(env, "SELECT target_type, target_name, channel, recipient, status FROM removal_requests");
  assert.deepEqual(req, { target_type: "broker", target_name: "MyLife", channel: "email", recipient: "membersupport@mylife.com", status: "sent" });
  const b = q(env, `SELECT listed, optout_submitted, next_check FROM brokers WHERE id=${ml.id}`)[0] as Record<string, unknown>;
  assert.equal(b.listed, 1);
  assert.ok(b.optout_submitted && b.next_check! > b.optout_submitted);
});

test("request validation keeps your edits and refuses unsafe drafts", async () => {
  const sent: Call[] = [];
  const env = { ...envWith(), REQUEST_FROM: "privacy@mydomain.example" };
  await mockMail(sent);
  rawDb(env.DB).exec("INSERT INTO brokers (name, site, optout_email) VALUES ('X','x.com','privacy@x.com')");
  const cases: [Record<string, string>, RegExp][] = [
    [{ to: "a@b.com, c@d.com", subject: "s", body: "b" }, /one email address/],
    [{ to: "a@b.com", subject: "s", body: "Page(s): [paste your profile URL(s) here]" }, /placeholder/],
    [{ to: "a@b.com", subject: "s", body: "my ssn 123-45-6789 and MY EDIT" }, /SSN-like/],
  ];
  for (const [form, re] of cases) {
    const html = await (await authed(env, "/brokers/1/request", form)).text();
    assert.match(html, re);
    assert.match(html, new RegExp(form.body.slice(0, 8).replace(/[()[\]]/g, "\\$&")), "draft preserved");
  }
  assert.equal(sent.length, 0);
});

test("site removal request for a web finding: actioned, follow-up in the report after 45 days", async () => {
  const sent: Call[] = [];
  const env = { ...envWith(), REQUEST_FROM: "privacy@mydomain.example" };
  await mockMail(sent);
  rawDb(env.DB).exec(
    "INSERT INTO findings (source, identifier, url, title, fingerprint, first_seen) VALUES ('websearch','Test Person','https://news.example.net/story','Story','fp1','2026-11-05')",
  );
  const form = await (await authed(env, "/findings/1/request")).text();
  assert.match(form, /To the news\.example\.net privacy team/);
  assert.match(form, /results-about-you|remove-outdated-content/);

  const ok = await authed(env, "/findings/1/request", { to: "editor@news.example.net", subject: "Remove", body: "Please remove." });
  assert.match(msgOf(ok), /Request sent/);
  assert.deepEqual(q(env, "SELECT status FROM findings"), [{ status: "actioned" }]);

  // The day before the re-check: not in the report. On the day: it is.
  const recheck = (q(env, "SELECT recheck_on FROM removal_requests")[0] as { recheck_on: string }).recheck_on;
  await runScan(env, "weekly", new Date(new Date(`${recheck}T13:00:00Z`).getTime() - 86400000));
  assert.doesNotMatch(JSON.parse(sent.at(-1)!.body).text, /Removal requests to confirm/);
  const r = await runScan(env, "weekly", new Date(`${recheck}T13:00:00Z`));
  assert.match(r.subject, /all clear/);
  const text = JSON.parse(sent.at(-1)!.body).text as string;
  assert.match(text, /Removal requests to confirm \(1\)/);
  assert.match(text, /news\.example\.net: removal requested/);

  assert.match(msgOf(await authed(env, "/requests/1/confirmed", {})), /confirmed/);
  await runScan(env, "weekly", new Date(`${recheck}T13:00:00Z`));
  assert.doesNotMatch(JSON.parse(sent.at(-1)!.body).text, /Removal requests to confirm/);
});

test("form-submitted logs the opt-out and sets dates", async () => {
  const sent: Call[] = [];
  const env = envWith();
  await mockMail(sent);
  rawDb(env.DB).exec("INSERT INTO brokers (name, site, optout_url) VALUES ('Spokeo','spokeo.com','https://www.spokeo.com/optout')");
  assert.match(msgOf(await authed(env, "/brokers/1/form-submitted", {})), /form submission logged/);
  assert.deepEqual(q(env, "SELECT channel, recipient, status FROM removal_requests"), [
    { channel: "form", recipient: "https://www.spokeo.com/optout", status: "sent" },
  ]);
  const html = await (await authed(env, "/dashboard")).text();
  assert.match(html, /Removal requests/);
  assert.match(html, /Spokeo/);
  assert.match(html, /Email requests are off until REQUEST_FROM/);
});
