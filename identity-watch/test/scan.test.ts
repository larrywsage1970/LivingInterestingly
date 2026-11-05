import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runScan } from "../src/scan.ts";
import { baseEnv, type Call, json, makeDb, mockFetch, rawDb } from "./helpers.ts";

let restore = () => {};
afterEach(() => restore());

const breach = (Name: string, DataClasses = ["Email addresses", "Passwords"]) => ({
  Name,
  Title: Name,
  Domain: `${Name.toLowerCase()}.com`,
  BreachDate: "2024-01-15",
  DataClasses,
  IsVerified: true,
});

function hibpRoutes(byEmail: Record<string, unknown[]>, emails: Call[] = []) {
  return {
    "https://hibp.test/api/v3/breachedaccount/": (req: Request) => {
      const email = decodeURIComponent(new URL(req.url).pathname.split("/").pop()!);
      const b = byEmail[email];
      return b ? json(b) : new Response(null, { status: 404 });
    },
    "https://resend.test/emails": async (req: Request) => {
      emails.push({ method: req.method, url: req.url, headers: req.headers, body: await req.text() });
      return json({ id: "msg_1" });
    },
  };
}

test("Phase 1 DoD: weekly run emails new HIBP breaches, repeat run sends all clear", async () => {
  const db = makeDb();
  const env = baseEnv(db);
  const sent: Call[] = [];
  const breaches: Record<string, unknown[]> = { "test.person@example.com": [breach("Acme"), breach("Widgets", ["Email addresses"])] };
  const m = mockFetch(hibpRoutes(breaches, sent));
  restore = m.restore;

  const r1 = await runScan(env, "weekly");
  assert.equal(r1.newFindings, 2);
  assert.equal(r1.subject, "Identity Watch: 2 new findings");
  assert.deepEqual(r1.errors, []);

  // HIBP request shape
  const hibpCall = m.calls.find((c) => c.url.includes("breachedaccount"))!;
  assert.equal(hibpCall.headers.get("hibp-api-key"), "hibp-test-key");
  assert.equal(hibpCall.headers.get("user-agent"), "identity-watch");
  assert.ok(hibpCall.url.endsWith("?truncateResponse=false"));
  // weekly run must not call Brave
  assert.ok(!m.calls.some((c) => c.url.startsWith("https://brave.test")));

  // Email content
  assert.equal(sent.length, 1);
  const mail = JSON.parse(sent[0].body);
  assert.deepEqual(mail.to, ["me@example.com"]);
  assert.match(mail.text, /New breaches \(2\)/);
  assert.match(mail.text, /Acme breach exposed test\.person@example\.com/);
  assert.match(mail.text, /change the password on acme\.com/);
  assert.equal(sent[0].headers.get("authorization"), "Bearer resend-test-key");

  // Run twice: no changes -> all clear
  const r2 = await runScan(env, "weekly");
  assert.equal(r2.newFindings, 0);
  assert.equal(r2.subject, "Identity Watch: all clear");
  assert.match(JSON.parse(sent[1].body).text, /No new breaches/);

  // A new breach appears -> only that one is reported
  breaches["other@example.org"] = [breach("Gadgets")];
  const r3 = await runScan(env, "weekly");
  assert.equal(r3.newFindings, 1);
  assert.match(JSON.parse(sent[2].body).text, /Gadgets/);
  assert.doesNotMatch(JSON.parse(sent[2].body).text, /Acme/);

  const raw = rawDb(db);
  assert.equal((raw.prepare("SELECT COUNT(*) n FROM findings").get() as { n: number }).n, 3);
  const runs = raw.prepare("SELECT kind, new_findings, errors FROM runs ORDER BY id").all();
  assert.deepEqual(runs.map((r) => ({ ...r })), [
    { kind: "weekly", new_findings: 2, errors: null },
    { kind: "weekly", new_findings: 0, errors: null },
    { kind: "weekly", new_findings: 1, errors: null },
  ]);
});

test("HIBP 429 honors retry-after and then succeeds", async () => {
  const db = makeDb();
  let hits = 0;
  const m = mockFetch({
    ...hibpRoutes({}),
    "https://hibp.test/api/v3/breachedaccount/": () =>
      ++hits === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : json([breach("Acme")]),
  });
  restore = m.restore;
  const env = baseEnv(db, { IDENTIFIERS_JSON: JSON.stringify({ emails: ["a@example.com"] }) });
  const r = await runScan(env, "weekly");
  assert.equal(hits, 2);
  assert.equal(r.newFindings, 1);
});

test("HIBP auth failure shows up as an error, never the key", async () => {
  const db = makeDb();
  const sent: Call[] = [];
  const m = mockFetch({ ...hibpRoutes({}, sent), "https://hibp.test/api/v3/breachedaccount/": () => new Response(null, { status: 401 }) });
  restore = m.restore;
  const r = await runScan(baseEnv(db), "weekly");
  assert.equal(r.subject, "Identity Watch: all clear (2 errors)");
  const text = JSON.parse(sent[0].body).text as string;
  assert.match(text, /HTTP 401 \(API key rejected\) for t\*\*\*@example\.com/);
  assert.doesNotMatch(text, /hibp-test-key/);
});

test("quarterly: web sweep, ignore list, broker seed, auto-flag broker listing", async () => {
  const db = makeDb();
  const sent: Call[] = [];
  const m = mockFetch({
    ...hibpRoutes({}, sent),
    "https://brave.test/res/v1/web/search": (req) => {
      const q = new URL(req.url).searchParams.get("q")!;
      if (q.includes("Springfield")) {
        return json({
          web: {
            results: [
              { title: "Test Person in Springfield, OH | <strong>Spokeo</strong>", url: "https://www.spokeo.com/Test-Person/Ohio/Springfield?utm_source=x#top", description: "Age 50s" },
              { title: "My blog", url: "https://blog.mysite.example/about", description: "mine" },
              { title: "News", url: "https://news.example.net/story", description: "local" },
            ],
          },
        });
      }
      return json({ web: { results: [] } });
    },
  });
  restore = m.restore;
  const env = baseEnv(db, { IGNORE_DOMAINS: "mysite.example, facebook.com" });

  const r = await runScan(env, "quarterly", new Date("2027-01-01T13:00:00Z"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.newFindings, 2); // spokeo + news; ignored domain dropped
  assert.equal(r.brokersDue, 16); // all unknown -> due

  // queries: 2 emails + name/city + name/address-phone
  const qs = m.calls.filter((c) => c.url.startsWith("https://brave.test")).map((c) => new URL(c.url).searchParams.get("q"));
  assert.deepEqual(qs, ['"test.person@example.com"', '"other@example.org"', '"Test Person" "Springfield, OH"', '"Test Person" address phone']);
  assert.equal(m.calls.find((c) => c.url.startsWith("https://brave.test"))!.headers.get("x-subscription-token"), "brave-test-key");

  const raw = rawDb(db);
  const urls = raw.prepare("SELECT url FROM findings WHERE source='websearch' ORDER BY url").all().map((r) => r.url);
  assert.deepEqual(urls, ["https://news.example.net/story", "https://www.spokeo.com/Test-Person/Ohio/Springfield"]);
  const spokeo = raw.prepare("SELECT listed, next_check FROM brokers WHERE name='Spokeo'").get() as { listed: number; next_check: string };
  assert.equal(spokeo.listed, 1);
  assert.equal(spokeo.next_check, "2027-01-01");

  const text = JSON.parse(sent[0].body).text as string;
  assert.match(text, /New web mentions \(2\)/);
  assert.match(text, /data broker listing on Spokeo: submit opt-out/);
  assert.match(text, /Brokers due for re-check \(16\)/);
  assert.match(text, /Spokeo \(listed\)/);
  assert.doesNotMatch(text, /<strong>/);

  // Second quarterly run: no new mentions, brokers still due (not yet worked)
  const r2 = await runScan(env, "quarterly", new Date("2027-04-01T13:00:00Z"));
  assert.equal(r2.newFindings, 0);
  assert.equal(r2.brokersDue, 16);
  assert.equal((raw.prepare("SELECT COUNT(*) n FROM brokers").get() as { n: number }).n, 16);
});

test("leak index (flagged on) stores leak name/date only", async () => {
  const db = makeDb();
  const sent: Call[] = [];
  const m = mockFetch({
    ...hibpRoutes({}, sent),
    "https://brave.test/": () => json({ web: { results: [] } }),
    "https://intelx.test/intelligent/search/result": () =>
      json({ status: 1, records: [{ systemid: "abc-123", name: "Collection #1/combo.txt", date: "2019-01-07T00:00:00Z", bucketh: "Leaks » Public" }] }),
    "https://intelx.test/intelligent/search/terminate": () => json({}),
    "https://intelx.test/intelligent/search": () => json({ id: "search-1", status: 0 }),
  });
  restore = m.restore;
  const env = baseEnv(db, {
    LEAKINDEX_ENABLED: "true",
    INTELX_API_KEY: "ix-key",
    INTELX_BASE_URL: "https://intelx.test",
    IDENTIFIERS_JSON: JSON.stringify({ emails: ["a@example.com"] }),
  });
  const r = await runScan(env, "manual");
  assert.deepEqual(r.errors, []);
  assert.equal(r.newFindings, 1);
  const row = rawDb(db).prepare("SELECT title, detail, url FROM findings WHERE source='leakindex'").get();
  assert.deepEqual({ ...row }, { title: "Collection #1/combo.txt", detail: "Leaks » Public · dated 2019-01-07", url: null });
  // never fetched file contents
  assert.ok(!m.calls.some((c) => /file\/(read|view|preview)/.test(c.url)));
});

test("bad identifiers: run fails safe and reports the error", async () => {
  const db = makeDb();
  const sent: Call[] = [];
  restore = mockFetch(hibpRoutes({}, sent)).restore;
  const r = await runScan(baseEnv(db, { IDENTIFIERS_JSON: JSON.stringify({ emails: ["a@example.com"], ssn: "123-45-6789" }) }), "weekly");
  assert.equal(r.newFindings, 0);
  assert.match(r.errors[0], /unsupported field "ssn"/);
  assert.doesNotMatch(JSON.parse(sent[0].body).text, /123-45-6789/);
});
