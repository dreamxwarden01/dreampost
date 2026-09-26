CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL,
  sha256 TEXT,
  state TEXT NOT NULL CHECK (state IN ('receiving', 'stored', 'blocked', 'delivered_pending_delete', 'done')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  last_enqueued_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);

CREATE INDEX deliveries_repair ON deliveries(state, next_attempt_at, lease_until);
