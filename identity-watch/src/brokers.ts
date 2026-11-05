// Data broker checklist: seed list, re-check due dates, auto-flag listings
// found by the web sweep. No broker sites are scraped.
import { addDays } from "./config.ts";
import type { BrokerRow, StoredFinding } from "./types.ts";

export interface BrokerSeed {
  name: string;
  site: string;
  optout_url: string | null;
  optout_email?: string;
  notes: string;
}

// Opt-out URLs and emails were checked against several 2025-2026 privacy guides on
// 2026-11-05. The broker sites themselves were not reachable from the build
// environment, so each one is marked UNVERIFIED until you open it once and
// confirm. Where the guides disagree, optout_url is left blank on purpose.
const UNVERIFIED = "URL from privacy guides, not yet opened. Confirm before submitting.";
const PEOPLECONNECT =
  "PeopleConnect Suppression Center. One verified request covers Intelius, Instant Checkmate, US Search, TruthFinder.";

export const BROKER_SEED: BrokerSeed[] = [
  { name: "Spokeo", site: "spokeo.com", optout_url: "https://www.spokeo.com/optout", notes: `${UNVERIFIED} Needs your profile URL; each listing opts out separately.` },
  { name: "Whitepages", site: "whitepages.com", optout_url: "https://www.whitepages.com/suppression-requests", optout_email: "privacyrequest@whitepages.com", notes: `${UNVERIFIED} Paste profile URL; may verify by phone call. Email address also from guides, unverified.` },
  { name: "BeenVerified", site: "beenverified.com", optout_url: "https://www.beenverified.com/app/optout/search", notes: `${UNVERIFIED} Older guides list other paths; if this fails use the footer opt-out link. Search name + state, pick record, verify by email within 48h. Covers its sister sites.` },
  { name: "Radaris", site: "radaris.com", optout_url: "https://radaris.com/control/privacy", notes: `${UNVERIFIED} Known to re-list. Re-check every cycle.` },
  { name: "Intelius", site: "intelius.com", optout_url: "https://suppression.peopleconnect.us/login", notes: `${UNVERIFIED} ${PEOPLECONNECT}` },
  { name: "TruePeopleSearch", site: "truepeoplesearch.com", optout_url: "https://www.truepeoplesearch.com/removal", notes: `${UNVERIFIED} Email + captcha.` },
  { name: "FastPeopleSearch", site: "fastpeoplesearch.com", optout_url: null, notes: "Guides list both /removal and /optout. Use the removal link in the site footer; email verification only." },
  { name: "MyLife", site: "mylife.com", optout_url: null, optout_email: "membersupport@mylife.com", notes: "No stable opt-out page found. Guides say email removal works (address unverified); profile removed within about 15 days." },
  { name: "PeopleFinders", site: "peoplefinders.com", optout_url: null, notes: "Opt-out URL not confirmed. Use the footer privacy link. Removal may also cover FastPeopleSearch." },
  { name: "ThatsThem", site: "thatsthem.com", optout_url: null, notes: "Opt-out URL not confirmed. Single web form per guides; find it in the footer." },
  { name: "Nuwber", site: "nuwber.com", optout_url: "https://nuwber.com/removal/link", notes: `${UNVERIFIED} Paste profile URL + email.` },
  { name: "Acxiom", site: "acxiom.com", optout_url: "https://isapps.acxiom.com/optout/optout.aspx", notes: `${UNVERIFIED} Marketing data broker, no public profiles. Submit once.` },
  { name: "Instant Checkmate", site: "instantcheckmate.com", optout_url: "https://suppression.peopleconnect.us/login", notes: `${UNVERIFIED} ${PEOPLECONNECT}` },
  { name: "US Search", site: "ussearch.com", optout_url: "https://suppression.peopleconnect.us/login", notes: `${UNVERIFIED} ${PEOPLECONNECT}` },
  { name: "PeekYou", site: "peekyou.com", optout_url: "https://www.peekyou.com/about/contact/optout", notes: `${UNVERIFIED} Needs profile URL.` },
  { name: "ClustrMaps", site: "clustrmaps.com", optout_url: "https://clustrmaps.com/bl/opt-out", notes: `${UNVERIFIED} Needs profile URL.` },
];

/**
 * Insert any brokers that are missing and fill blank opt-out emails. Never
 * overwrites your edits, and never re-adds a broker you removed (removed = 1
 * keeps the row as a tombstone).
 */
export async function seedBrokers(db: D1Database): Promise<void> {
  await db.batch(
    BROKER_SEED.flatMap((b) => [
      db
        .prepare("INSERT OR IGNORE INTO brokers (name, site, optout_url, optout_email, notes) VALUES (?, ?, ?, ?, ?)")
        .bind(b.name, b.site, b.optout_url, b.optout_email ?? null, b.notes),
      ...(b.optout_email
        ? [db.prepare("UPDATE brokers SET optout_email = ? WHERE name = ? AND optout_email IS NULL").bind(b.optout_email, b.name)]
        : []),
    ]),
  );
}

/** Due when never checked, or next_check has arrived. */
export async function dueBrokers(db: D1Database, todayIso: string): Promise<BrokerRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM brokers WHERE removed = 0 AND (next_check IS NULL OR next_check <= ?) ORDER BY listed DESC, name")
    .bind(todayIso)
    .all<BrokerRow>();
  return results ?? [];
}

/**
 * When to look at this broker again.
 * - Opt-out submitted: submitted + interval (verify it stuck).
 * - Checked and not listed, or listed but not yet submitted: today + interval.
 * - Unknown: null (shows as due until you check it).
 */
export function nextCheck(listed: number, optoutSubmitted: string | null, todayIso: string, days: number): string | null {
  if (optoutSubmitted) return addDays(optoutSubmitted, days);
  if (listed === 2) return addDays(todayIso, days);
  if (listed === 1) return todayIso; // listed, nothing submitted: stays due
  return null;
}

export function brokerForHost(host: string): BrokerSeed | undefined {
  return BROKER_SEED.find((b) => host === b.site || host.endsWith(`.${b.site}`));
}

/** Web hits on a broker domain mark that broker as listed (if still unknown). */
export async function flagListedFromFindings(db: D1Database, findings: StoredFinding[], todayIso: string): Promise<string[]> {
  const names = new Set<string>();
  for (const f of findings) {
    if (f.source !== "websearch" || !f.url) continue;
    try {
      const b = brokerForHost(new URL(f.url).hostname.toLowerCase().replace(/^www\./, ""));
      if (b) names.add(b.name);
    } catch {
      /* bad url */
    }
  }
  if (names.size === 0) return [];
  await db.batch(
    [...names].map((n) =>
      db.prepare("UPDATE brokers SET listed = 1, next_check = ? WHERE name = ? AND listed = 0 AND removed = 0").bind(todayIso, n),
    ),
  );
  return [...names];
}
