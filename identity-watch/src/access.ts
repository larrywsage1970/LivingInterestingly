// Verify the Cloudflare Access JWT on every HTTP request. Defense in depth:
// even if the Access policy is misconfigured or the route is exposed some
// other way, requests without a valid token for OUR application are refused.
// Not configured = every route refused (fail closed).
import type { Env } from "./config.ts";

interface Jwk extends JsonWebKey {
  kid: string;
}

let certCache: { team: string; keys: Jwk[]; at: number } | null = null;
const CERT_TTL_MS = 60 * 60 * 1000;

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

const teamOrigin = (team: string): string => `https://${team.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;

async function getKeys(team: string, force = false): Promise<Jwk[]> {
  if (!force && certCache && certCache.team === team && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const res = await fetch(`${teamOrigin(team)}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  certCache = { team, keys, at: Date.now() };
  return keys;
}

export interface AccessIdentity {
  email?: string;
  sub?: string;
}

export async function verifyAccess(req: Request, env: Env, now = Date.now()): Promise<AccessIdentity | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token =
    req.headers.get("cf-access-jwt-assertion") ??
    /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; sub?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  let keys = await getKeys(env.ACCESS_TEAM_DOMAIN);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys(env.ACCESS_TEAM_DOMAIN, true); // key rotation
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;

  const nowSec = Math.floor(now / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== teamOrigin(env.ACCESS_TEAM_DOMAIN)) return null;
  if (!payload.exp || payload.exp < nowSec) return null;
  if (payload.nbf && payload.nbf > nowSec + 60) return null;
  return { email: payload.email, sub: payload.sub };
}

/** Test hook. */
export const _resetAccessCache = (): void => {
  certCache = null;
};
