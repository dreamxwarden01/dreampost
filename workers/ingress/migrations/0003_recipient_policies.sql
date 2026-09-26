-- Retain disabled targets and revisions so address reuse cannot reset ordering.
CREATE TABLE recipient_policies (
  address TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  receive_enabled INTEGER NOT NULL CHECK (receive_enabled IN (0, 1)),
  operation_id TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- Historical evidence supports idempotent retries after later revisions are applied.
CREATE TABLE recipient_policy_operations (
  operation_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy_digest TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  UNIQUE (address, revision)
);
