-- A stable session reference survives token rotation without granting by principal alone.
ALTER TABLE auth_sessions ADD COLUMN session_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX auth_sessions_session_id ON auth_sessions(session_id);

CREATE TABLE attachment_download_sessions (
  id uuid PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('sso','development')),
  source_session_id uuid REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
  principal_id uuid REFERENCES principals(id) ON DELETE CASCADE,
  development_token_hash text,
  flow_id uuid NOT NULL UNIQUE,
  challenge_hash text NOT NULL CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  ticket_hash text NOT NULL UNIQUE CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  ticket_expires_at timestamptz NOT NULL,
  secret_hash text CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  download_origin text NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_kind = 'sso' AND source_session_id IS NOT NULL AND principal_id IS NOT NULL AND development_token_hash IS NULL)
    OR (source_kind = 'development' AND source_session_id IS NULL AND principal_id IS NULL AND development_token_hash IS NOT NULL AND development_token_hash ~ '^[0-9a-f]{64}$')),
  CHECK ((redeemed_at IS NULL AND secret_hash IS NULL) OR (redeemed_at IS NOT NULL AND secret_hash IS NOT NULL))
);
CREATE INDEX attachment_download_sessions_source ON attachment_download_sessions(source_session_id,expires_at);
CREATE INDEX attachment_download_sessions_expiry ON attachment_download_sessions(expires_at);

CREATE TABLE attachment_download_transfers (
  session_id uuid NOT NULL REFERENCES attachment_download_sessions(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  attachment_id uuid NOT NULL REFERENCES attachment_objects(id),
  delivery_id uuid NOT NULL REFERENCES deliveries(id),
  purpose text NOT NULL CHECK (purpose IN ('download','preview')),
  PRIMARY KEY (session_id,id)
);

CREATE TABLE attachment_control_nonces (
  key_id text NOT NULL,
  nonce uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key_id,nonce)
);
CREATE INDEX attachment_control_nonces_expiry ON attachment_control_nonces(expires_at);
