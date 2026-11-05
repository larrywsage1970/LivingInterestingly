-- Identity Watch schema. Stores breach names and URLs only: never passwords,
-- hashes, leaked records, SSNs, or account numbers.
CREATE TABLE findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,              -- hibp | websearch | leakindex
  identifier TEXT NOT NULL,          -- which email/name matched
  title TEXT,
  url TEXT,
  detail TEXT,
  fingerprint TEXT NOT NULL UNIQUE,  -- sha256(source|identifier|url-or-breach)
  first_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' -- new | reviewed | dismissed | actioned
);

CREATE TABLE brokers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  site TEXT,
  optout_url TEXT,
  listed INTEGER DEFAULT 0,          -- 0 unknown, 1 listed, 2 not listed
  optout_submitted TEXT,
  next_check TEXT,
  notes TEXT
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started TEXT NOT NULL,
  kind TEXT NOT NULL,                -- weekly | quarterly | manual
  new_findings INTEGER DEFAULT 0,
  errors TEXT
);

CREATE INDEX idx_findings_status ON findings(status, first_seen);
