-- Operator workflows are local maintenance actions, not impersonated RP sessions.
ALTER TABLE address_policy_outbox DROP CONSTRAINT address_policy_outbox_status_check;
ALTER TABLE address_policy_outbox ADD CONSTRAINT address_policy_outbox_status_check
  CHECK (status IN ('pending', 'inflight', 'applied', 'blocked', 'superseded', 'prepared'));
ALTER TABLE address_policy_outbox ADD COLUMN dispatch_kind text NOT NULL DEFAULT 'normal'
  CHECK (dispatch_kind IN ('normal', 'legacy_prepare', 'reconcile'));

CREATE TABLE legacy_route_cutovers (
  id uuid PRIMARY KEY,
  address text NOT NULL UNIQUE REFERENCES address_registry(address),
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  allocation_id uuid NOT NULL REFERENCES address_allocations(id),
  operation_id uuid NOT NULL UNIQUE REFERENCES address_policy_history(operation_id),
  phase text NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared', 'dynamic_compatibility')),
  prepared_by text NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  staged_at timestamptz,
  stage_verified_at timestamptz,
  stage_gateway_id text,
  stage_worker_version text,
  stage_inspection_request_id uuid,
  stage_inspection_sha256 text,
  stage_inspection jsonb,
  verified_at timestamptz,
  gateway_id text,
  worker_version text,
  inspection_request_id uuid,
  inspection_sha256 text,
  inspection jsonb
);
CREATE TABLE address_operator_plans (
  id uuid PRIMARY KEY,
  address text NOT NULL REFERENCES address_registry(address),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  plan_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'publishing', 'applied', 'failed', 'superseded', 'recovered')),
  published_operation_id uuid REFERENCES address_policy_history(operation_id),
  reserved_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  recovered_at timestamptz,
  recovery_sha256 text,
  recovery_evidence jsonb,
  recovered_by text
);
CREATE FUNCTION preserve_operator_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.address IS DISTINCT FROM OLD.address
    OR NEW.plan_sha256 IS DISTINCT FROM OLD.plan_sha256 OR NEW.plan_json IS DISTINCT FROM OLD.plan_json
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Operator plans are immutable; create a fresh plan';
  END IF;
  IF OLD.recovered_at IS NOT NULL AND
    ROW(NEW.recovered_at,NEW.recovery_sha256,NEW.recovery_evidence,NEW.recovered_by) IS DISTINCT FROM
    ROW(OLD.recovered_at,OLD.recovery_sha256,OLD.recovery_evidence,OLD.recovered_by) THEN
    RAISE EXCEPTION 'Recorded recovery evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_operator_plan BEFORE UPDATE ON address_operator_plans
  FOR EACH ROW EXECUTE FUNCTION preserve_operator_plan();
CREATE FUNCTION preserve_legacy_cutover_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.address IS DISTINCT FROM OLD.address
    OR NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id OR NEW.allocation_id IS DISTINCT FROM OLD.allocation_id
    OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.prepared_by IS DISTINCT FROM OLD.prepared_by
    OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at THEN
    RAISE EXCEPTION 'Legacy cutover bindings are immutable';
  END IF;
  IF OLD.staged_at IS NOT NULL AND NEW.staged_at IS DISTINCT FROM OLD.staged_at THEN
    RAISE EXCEPTION 'Recorded staging acknowledgment is immutable';
  END IF;
  IF OLD.stage_verified_at IS NOT NULL AND
    ROW(NEW.stage_verified_at,NEW.stage_gateway_id,NEW.stage_worker_version,NEW.stage_inspection_request_id,NEW.stage_inspection_sha256,NEW.stage_inspection) IS DISTINCT FROM
    ROW(OLD.stage_verified_at,OLD.stage_gateway_id,OLD.stage_worker_version,OLD.stage_inspection_request_id,OLD.stage_inspection_sha256,OLD.stage_inspection) THEN
    RAISE EXCEPTION 'Verified static staging evidence is immutable';
  END IF;
  IF OLD.verified_at IS NOT NULL AND
    ROW(NEW.phase,NEW.verified_at,NEW.gateway_id,NEW.worker_version,NEW.inspection_request_id,NEW.inspection_sha256,NEW.inspection) IS DISTINCT FROM
    ROW(OLD.phase,OLD.verified_at,OLD.gateway_id,OLD.worker_version,OLD.inspection_request_id,OLD.inspection_sha256,OLD.inspection) THEN
    RAISE EXCEPTION 'Recorded dynamic compatibility evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_legacy_cutover_binding BEFORE UPDATE ON legacy_route_cutovers
  FOR EACH ROW EXECUTE FUNCTION preserve_legacy_cutover_binding();
