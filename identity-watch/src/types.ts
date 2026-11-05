export type Source = "hibp" | "websearch" | "leakindex";

/** A finding before it is stored. `key` is the url-or-breach part of the fingerprint. */
export interface Finding {
  source: Source;
  identifier: string;
  title: string;
  url: string | null;
  detail: string;
  key: string;
}

export interface StoredFinding extends Finding {
  id: number;
  fingerprint: string;
  first_seen: string;
}

export interface SourceResult {
  findings: Finding[];
  errors: string[];
}

export interface BrokerRow {
  id: number;
  name: string;
  site: string | null;
  optout_url: string | null;
  listed: number;
  optout_submitted: string | null;
  next_check: string | null;
  notes: string | null;
  optout_email: string | null;
  removed: number;
}

export interface RemovalRequestRow {
  id: number;
  target_type: "broker" | "finding";
  target_id: number;
  target_name: string;
  channel: "email" | "form";
  recipient: string | null;
  subject: string | null;
  body: string | null;
  sent_at: string;
  recheck_on: string | null;
  status: "sent" | "confirmed" | "failed";
}

export type RunKind = "weekly" | "quarterly" | "manual";
