import assert from "node:assert/strict";
import { test } from "node:test";
import { BROKER_SEED, nextCheck } from "../src/brokers.ts";
import { addDays, loadIdentifiers, mask } from "../src/config.ts";
import { fingerprint } from "../src/diff.ts";
import { kindForCron, QUARTERLY_CRON } from "../src/schedule.ts";
import { buildReport } from "../src/report.ts";
import { normalizeUrl } from "../src/sources/websearch.ts";
import { readFileSync } from "node:fs";

const ids = (o: unknown) => loadIdentifiers({ IDENTIFIERS_JSON: JSON.stringify(o) } as never);

test("identifiers: accepts the spec shape, rejects sensitive data", () => {
  const ok = ids({ emails: ["A@Example.com"], names: ["Test Person", "Test Q Person"], city: "Springfield, OH", phones: ["+1 330 555 1234"] });
  assert.deepEqual(ok.emails, ["a@example.com"]);
  assert.throws(() => ids({ names: ["Test 123-45-6789"] }), /SSN-like/);
  assert.throws(() => ids({ emails: ["a@example.com"], names: ["4111 1111 1111 1111"] }), /card-like/);
  assert.throws(() => ids({ emails: ["a@example.com"], dob: "1970-01-01" }), /unsupported field/);
  assert.throws(() => ids({ emails: ["nope"] }), /invalid address/);
  assert.throws(() => ids({}), /at least one/);
  assert.throws(() => loadIdentifiers({} as never), /not set/);
});

test("mask hides identifiers in errors/logs", () => {
  assert.equal(mask("test.person@example.com"), "t***@example.com");
  assert.equal(mask("Test Person"), "T*** P***");
});

test("fingerprint is stable and case-insensitive on identifier", async () => {
  const a = await fingerprint({ source: "hibp", identifier: "A@x.com", title: "", url: null, detail: "", key: "Acme" });
  const b = await fingerprint({ source: "hibp", identifier: "a@x.com", title: "changed", url: "u", detail: "d", key: "Acme" });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("url normalization strips tracking and fragments", () => {
  assert.equal(normalizeUrl("https://Example.com/a/?utm_source=x&id=2#frag"), "https://example.com/a/?id=2");
  assert.equal(normalizeUrl("https://example.com/a/"), "https://example.com/a");
});

test("broker re-check dates", () => {
  assert.equal(nextCheck(1, "2026-11-05", "2026-11-10", 90), "2027-02-03");
  assert.equal(nextCheck(2, null, "2026-11-05", 90), "2027-02-03");
  assert.equal(nextCheck(1, null, "2026-11-05", 90), "2026-11-05");
  assert.equal(nextCheck(0, null, "2026-11-05", 90), null);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("broker seed: all 16 from the spec, https URLs only", () => {
  assert.equal(BROKER_SEED.length, 16);
  assert.equal(new Set(BROKER_SEED.map((b) => b.name)).size, 16);
  for (const b of BROKER_SEED) if (b.optout_url) assert.match(b.optout_url, /^https:\/\//);
});

test("cron mapping matches wrangler.toml", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.ok(toml.includes(`"${QUARTERLY_CRON}"`));
  assert.equal(kindForCron(QUARTERLY_CRON), "quarterly");
  assert.equal(kindForCron("0 13 * * 1"), "weekly");
});

test("report escapes HTML and shows errors", () => {
  const r = buildReport({
    kind: "weekly",
    date: "2026-11-05",
    findings: [{ id: 1, source: "websearch", identifier: "x", title: "<script>", url: "https://e.com", detail: "", key: "k", fingerprint: "f", first_seen: "" }],
    brokersDue: [],
    errors: ["boom"],
  });
  assert.equal(r.subject, "Identity Watch: 1 new finding (1 error)");
  assert.ok(!r.html.includes("<script>"));
  assert.match(r.text, /Errors\n------\n\* boom/);
});
