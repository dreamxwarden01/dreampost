CREATE TABLE auth_roles (
  role_id integer PRIMARY KEY,
  name text NOT NULL UNIQUE,
  permission_level integer NOT NULL,
  is_system boolean NOT NULL DEFAULT false
);
INSERT INTO auth_roles (role_id, name, permission_level, is_system) VALUES
  (0, 'postmaster', 0, true), (1, 'member', 10, true), (2, 'viewer', 20, true);

CREATE TABLE auth_role_permissions (
  role_id integer NOT NULL REFERENCES auth_roles(role_id),
  permission text NOT NULL CHECK (permission IN ('mailbox.use', 'addresses.manage', 'roles.manage')),
  PRIMARY KEY (role_id, permission)
);
INSERT INTO auth_role_permissions (role_id, permission) VALUES
  (0, 'mailbox.use'), (0, 'addresses.manage'), (0, 'roles.manage'),
  (1, 'mailbox.use'), (2, 'mailbox.use');

ALTER TABLE principals
  ADD COLUMN username text NOT NULL DEFAULT '',
  ADD COLUMN display_name text NOT NULL DEFAULT '',
  ADD COLUMN email text,
  ADD COLUMN avatar text,
  ADD COLUMN app_role integer REFERENCES auth_roles(role_id),
  ADD COLUMN access_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auth_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN profile_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN revoked_token_iat bigint NOT NULL DEFAULT 0,
  ADD COLUMN last_identity_iat bigint NOT NULL DEFAULT 0;

CREATE TABLE auth_user_permission_overrides (
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('mailbox.use', 'addresses.manage', 'roles.manage')),
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  PRIMARY KEY (principal_id, permission)
);

CREATE TABLE auth_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  default_role_id integer NOT NULL REFERENCES auth_roles(role_id),
  last_catalog_sync timestamptz,
  catalog_issuer text,
  catalog_client_id text
);
INSERT INTO auth_settings (singleton, default_role_id) VALUES (true, 1);

CREATE TABLE auth_flows (
  state text PRIMARY KEY,
  issuer text NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  cookie_hash text NOT NULL,
  verifier text NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  sso_sid text NOT NULL,
  auth_version bigint NOT NULL,
  csrf_token text NOT NULL,
  id_token_hint text NOT NULL,
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  next_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_subject ON auth_sessions (principal_id);
CREATE INDEX auth_sessions_sso_sid ON auth_sessions (sso_sid);

-- Keep a revocation tombstone so an in-flight callback cannot recreate a signed-out session.
CREATE TABLE auth_revoked_sids (
  issuer text NOT NULL,
  sid text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, sid)
);

CREATE TABLE auth_events (
  issuer text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, event_id)
);

-- Covers revocations received before a subject has ever logged in to this RP.
CREATE TABLE auth_subject_invalidations (
  issuer text NOT NULL,
  subject text NOT NULL,
  not_before_iat bigint NOT NULL,
  PRIMARY KEY (issuer, subject)
);
