-- Mailbox identity owns history; a display address is not a unique identity.
ALTER TABLE mailboxes DROP CONSTRAINT IF EXISTS mailboxes_address_key;
DROP INDEX IF EXISTS mailboxes_address_casefold;
ALTER TABLE mailboxes ADD COLUMN mailbox_type text NOT NULL DEFAULT 'shared'
  CHECK (mailbox_type IN ('personal', 'shared'));
ALTER TABLE mailboxes ADD COLUMN owner_principal_id uuid REFERENCES principals(id);
ALTER TABLE mailboxes ADD COLUMN provisioning_status text NOT NULL DEFAULT 'ready'
  CHECK (provisioning_status IN ('ready', 'needs_address', 'pending_activation'));
ALTER TABLE mailboxes ADD COLUMN provisioning_code text;
ALTER TABLE mailboxes ADD CONSTRAINT personal_mailbox_owner_required
  CHECK (mailbox_type <> 'personal' OR owner_principal_id IS NOT NULL);
CREATE UNIQUE INDEX personal_mailbox_per_principal ON mailboxes(owner_principal_id)
  WHERE mailbox_type = 'personal';

CREATE TABLE address_registry (
  address text PRIMARY KEY CHECK (address = lower(address)),
  domain text NOT NULL,
  state text NOT NULL CHECK (state IN ('allocated', 'retired')),
  current_allocation_id uuid,
  policy_revision bigint NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE address_allocations (
  id uuid PRIMARY KEY,
  address text NOT NULL REFERENCES address_registry(address),
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  source text NOT NULL CHECK (source IN ('legacy', 'first_login', 'approved', 'manual', 'reactivated', 'reassigned')),
  created_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  receive_only boolean NOT NULL DEFAULT false,
  send_generation bigint NOT NULL DEFAULT 1 CHECK (send_generation > 0)
);
CREATE UNIQUE INDEX one_current_address_allocation ON address_allocations(address) WHERE ended_at IS NULL;
ALTER TABLE address_registry ADD CONSTRAINT registry_current_allocation_fk
  FOREIGN KEY (current_allocation_id) REFERENCES address_allocations(id);
CREATE INDEX allocation_mailbox_history ON address_allocations(mailbox_id, created_at);
CREATE TABLE address_holds (
  allocation_id uuid NOT NULL REFERENCES address_allocations(id),
  kind text NOT NULL CHECK (kind IN ('owner', 'admin', 'system')),
  active boolean NOT NULL,
  changed_by uuid REFERENCES principals(id),
  reason text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (allocation_id, kind)
);
CREATE TABLE address_send_grants (
  id uuid PRIMARY KEY,
  allocation_id uuid NOT NULL REFERENCES address_allocations(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  granted_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX one_active_address_send_grant ON address_send_grants(allocation_id, principal_id)
  WHERE revoked_at IS NULL;
CREATE TABLE address_requests (
  id uuid PRIMARY KEY,
  requester_id uuid NOT NULL REFERENCES principals(id),
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  address text NOT NULL CHECK (address = lower(address)),
  action text NOT NULL CHECK (action IN ('add', 'reactivate')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by uuid REFERENCES principals(id),
  decision_reason text NOT NULL DEFAULT '',
  allocation_id uuid REFERENCES address_allocations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX one_pending_address_request ON address_requests(requester_id, address, action)
  WHERE status = 'pending';

-- History proves the recipient binding at admission, including when its ACK was lost.
CREATE TABLE address_policy_history (
  operation_id uuid PRIMARY KEY,
  address text NOT NULL REFERENCES address_registry(address),
  allocation_id uuid NOT NULL REFERENCES address_allocations(id),
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  previous_revision bigint NOT NULL CHECK (previous_revision >= 0),
  revision bigint NOT NULL CHECK (revision = previous_revision + 1),
  receive_enabled boolean NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (address, revision)
);
CREATE INDEX address_admission_history ON address_policy_history(allocation_id, revision, sha256);
CREATE TABLE address_policy_outbox (
  operation_id uuid PRIMARY KEY REFERENCES address_policy_history(operation_id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'inflight', 'applied', 'blocked')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_id uuid,
  last_error_code text,
  applied_at timestamptz
);
CREATE INDEX due_address_policies ON address_policy_outbox(available_at) WHERE status IN ('pending', 'inflight');
CREATE TABLE address_audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES principals(id),
  allocation_id uuid REFERENCES address_allocations(id),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Preserve configured legacy routes without granting their mailbox to a new login.
INSERT INTO address_registry(address, domain, state)
  SELECT lower(address), split_part(lower(address), '@', 2), 'allocated' FROM recipient_routes;
INSERT INTO address_allocations(id, address, mailbox_id, source, receive_only)
  SELECT gen_random_uuid(), lower(address), mailbox_id, 'legacy', true FROM recipient_routes;
UPDATE address_registry r SET current_allocation_id = a.id FROM address_allocations a WHERE a.address = r.address;
INSERT INTO address_holds(allocation_id, kind, active, reason)
  SELECT a.id, 'admin', NOT r.enabled, 'Imported legacy route policy'
  FROM recipient_routes r JOIN address_allocations a ON a.address = lower(r.address);

CREATE FUNCTION preserve_address_allocation_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.address IS DISTINCT FROM OLD.address
     OR NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION 'Address allocation bindings and ended epochs are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_allocation_binding BEFORE UPDATE ON address_allocations
  FOR EACH ROW EXECUTE FUNCTION preserve_address_allocation_binding();
CREATE FUNCTION preserve_address_policy_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Address policy history is immutable';
END $$;
CREATE TRIGGER immutable_policy_history BEFORE UPDATE OR DELETE ON address_policy_history
  FOR EACH ROW EXECUTE FUNCTION preserve_address_policy_history();

-- An established owner cannot be replaced to transfer the mailbox's private history.
-- An ownerless legacy/shared mailbox may still be explicitly assigned once.
CREATE FUNCTION preserve_mailbox_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.owner_principal_id IS NOT NULL AND
    (NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id OR NEW.mailbox_type IS DISTINCT FROM OLD.mailbox_type) THEN
    RAISE EXCEPTION 'Established mailbox ownership and type are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_mailbox_owner BEFORE UPDATE ON mailboxes
  FOR EACH ROW EXECUTE FUNCTION preserve_mailbox_owner();
