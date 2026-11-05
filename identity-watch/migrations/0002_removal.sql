-- Removal support: broker email channel, soft-delete for brokers (so the seed
-- list does not re-add one you removed), and a log of removal requests.
ALTER TABLE brokers ADD COLUMN optout_email TEXT;
ALTER TABLE brokers ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE removal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,         -- broker | finding
  target_id INTEGER NOT NULL,
  target_name TEXT NOT NULL,         -- broker name or site host, for the log
  channel TEXT NOT NULL,             -- email | form
  recipient TEXT,                    -- email address, when channel = email
  subject TEXT,
  body TEXT,                         -- exact text sent, as your record
  sent_at TEXT NOT NULL,
  recheck_on TEXT,                   -- when to search again and confirm
  status TEXT NOT NULL DEFAULT 'sent' -- sent | confirmed | failed
);

CREATE INDEX idx_requests_due ON removal_requests(status, recheck_on);
