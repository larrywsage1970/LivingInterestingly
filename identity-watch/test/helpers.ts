// Test helpers: a minimal D1 over node:sqlite running the real migration, and
// a fetch router so no test touches the network.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/config.ts";

class Stmt {
  db: DatabaseSync;
  sql: string;
  args: unknown[] = [];
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...a: unknown[]) {
    this.args = a.map((v) => (v === undefined ? null : v));
    return this;
  }
  exec() {
    const p = this.db.prepare(this.sql);
    if (/\breturning\b/i.test(this.sql) || /^\s*select/i.test(this.sql)) {
      const rows = p.all(...(this.args as never[])).map((r) => ({ ...r }));
      return { results: rows, success: true, meta: { changes: rows.length } };
    }
    const r = p.run(...(this.args as never[]));
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
  async all() {
    return this.exec();
  }
  async run() {
    return this.exec();
  }
  async first() {
    return this.exec().results[0] ?? null;
  }
}

export function makeDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(f, dir), "utf8"));
  }
  const d1 = {
    _raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return d1 as unknown as D1Database;
}

export const rawDb = (d: D1Database): DatabaseSync => (d as unknown as { _raw: DatabaseSync })._raw;

type Handler = (req: Request) => Response | Promise<Response>;
export interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

/** Replace global fetch with a prefix-matched router. Returns recorded calls. */
export function mockFetch(routes: Record<string, Handler>): { calls: Call[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.method === "GET" ? "" : await req.clone().text();
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const key = Object.keys(routes).find((k) => req.url.startsWith(k));
    if (!key) throw new Error(`unmocked fetch: ${req.url}`);
    return routes[key](req);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

export const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

export function baseEnv(db: D1Database, over: Partial<Env> = {}): Env {
  return {
    DB: db,
    IDENTIFIERS_JSON: JSON.stringify({
      emails: ["test.person@example.com", "other@example.org"],
      names: ["Test Person"],
      city: "Springfield, OH",
      phones: [],
    }),
    HIBP_API_KEY: "hibp-test-key",
    BRAVE_API_KEY: "brave-test-key",
    RESEND_API_KEY: "resend-test-key",
    REPORT_TO: "me@example.com",
    HIBP_BASE_URL: "https://hibp.test/api/v3",
    BRAVE_BASE_URL: "https://brave.test",
    RESEND_BASE_URL: "https://resend.test",
    HIBP_DELAY_MS: "0",
    BRAVE_DELAY_MS: "0",
    WEBSEARCH_ENABLED: "true",
    LEAKINDEX_ENABLED: "false",
    ...over,
  };
}
