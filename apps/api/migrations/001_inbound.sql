CREATE TABLE principals (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE mailboxes (
  id uuid PRIMARY KEY,
  address text NOT NULL UNIQUE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  change_sequence bigint NOT NULL DEFAULT 0 CHECK (change_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Reserved for future user authorization; development access does not populate it.
CREATE TABLE mailbox_memberships (
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  permissions text[] NOT NULL DEFAULT '{}',
  revoked_at timestamptz,
  PRIMARY KEY (mailbox_id, principal_id)
);

CREATE TABLE recipient_routes (
  address text PRIMARY KEY,
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY,
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  metadata jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  raw_size integer NOT NULL CHECK (raw_size > 0 AND raw_size <= 26214400),
  received_at timestamptz NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  parse_status text NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending', 'parsed', 'failed')),
  subject text NOT NULL DEFAULT '',
  from_header text NOT NULL DEFAULT '',
  to_header text NOT NULL DEFAULT '',
  plain_text text NOT NULL DEFAULT '',
  preview text NOT NULL DEFAULT '',
  deleted_at timestamptz,
  draft_version bigint NOT NULL DEFAULT 0
);
CREATE INDEX deliveries_mailbox_received ON deliveries (mailbox_id, received_at DESC, id DESC);

CREATE TABLE durable_jobs (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL UNIQUE REFERENCES deliveries(id),
  kind text NOT NULL CHECK (kind = 'parse'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  completed_at timestamptz
);
CREATE INDEX durable_jobs_due ON durable_jobs (available_at) WHERE status = 'pending';

-- A mailbox row lock serializes this sequence with the corresponding business commit.
CREATE TABLE mailbox_changes (
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  sequence bigint NOT NULL,
  delivery_id uuid NOT NULL REFERENCES deliveries(id),
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, sequence)
);

CREATE TABLE mutation_keys (
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  key text NOT NULL,
  request_sha256 text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, key)
);
