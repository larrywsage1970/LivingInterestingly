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
