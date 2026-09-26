-- Published policies are full-state snapshots. Preserve all history while newer
-- desired revisions replace older work that has not completed locally.
ALTER TABLE address_policy_outbox DROP CONSTRAINT address_policy_outbox_status_check;
ALTER TABLE address_policy_outbox ADD CONSTRAINT address_policy_outbox_status_check
  CHECK (status IN ('pending', 'inflight', 'applied', 'blocked', 'superseded'));
ALTER TABLE address_policy_outbox ADD COLUMN superseded_at timestamptz;
UPDATE address_policy_outbox o SET status = 'superseded', superseded_at = now(),
  lease_id = NULL, lease_until = NULL, last_error_code = NULL
FROM address_policy_history h JOIN address_registry r ON r.address = h.address
WHERE o.operation_id = h.operation_id AND h.revision < r.policy_revision
  AND o.status IN ('pending', 'inflight', 'blocked');
