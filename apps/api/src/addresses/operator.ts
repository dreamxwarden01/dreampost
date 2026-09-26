import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashRoutePolicy, sha256Hex, validateGatewayInspection, matchesPolicyAck,
  type GatewayInspection, type GatewayOperationStatus, type RemotePolicyExpectation, type PreparedPolicyAck, type PolicyAck, type RoutePolicy } from '@dreampost/protocol';
import { ApiError } from '../errors.js';
import { normalizeHostedAddress, requireUuid } from './service.js';

/** Implementations authenticate gateway responses and bind inspection responses to a fresh request nonce. */
export interface OperatorGatewayClient {
  inspect(address: string): Promise<GatewayInspection>;
  stage(policy: RoutePolicy): Promise<PreparedPolicyAck>;
  operationStatus(address: string, operationId: string): Promise<GatewayOperationStatus>;
  reconcile(policy: RoutePolicy, expectedRemote: RemotePolicyExpectation): Promise<PolicyAck>;
}
export interface AddressOperatorConfig { allowedAddresses: readonly string[]; now?: () => number }
export interface LegacyCutover {
  id: string; address: string; mailboxId: string; allocationId: string; operationId: string;
  phase: 'prepared' | 'dynamic_compatibility'; confirmedOperationId: string | null; stagedAt: string | null; stageVerifiedAt: string | null; stageGatewayId: string | null; stageWorkerVersion: string | null; verifiedAt: string | null; gatewayId: string | null; workerVersion: string | null;
}
interface CutoverRow {
  id: string; address: string; mailbox_id: string; allocation_id: string; operation_id: string;
  phase: LegacyCutover['phase']; staged_at: Date | null; verified_at: Date | null; inspection: GatewayInspection | null;
  stage_verified_at: Date | null; stage_gateway_id: string | null; stage_worker_version: string | null;
  stage_inspection: GatewayInspection | null; gateway_id: string | null; worker_version: string | null;
}
interface LocalSnapshot {
  address: string; revision: number; currentAllocationId: string | null; allocationId: string; mailboxId: string;
  source: string; mailboxEnabled: boolean; receiveOnly: boolean; sendingGeneration: number;
  ownerPaused: boolean; adminPaused: boolean; systemPaused: boolean; receiveEnabled: boolean;
  legacyMailboxId: string | null; legacyEnabled: boolean | null;
}
export interface PolicyReconciliationPlan {
  version: 1; planId: string; address: string; operatorLabel: string; createdAt: number; expiresAt: number;
  gatewayId: string; workerVersion: string; expectedLocal: LocalSnapshot;
  expectedRemote: RemotePolicyExpectation; remoteInspection: GatewayInspection; policy: RoutePolicy; digest: string;
}
interface PlanRow {
  id: string; address: string; plan_sha256: string; plan_json: Omit<PolicyReconciliationPlan, 'digest'>;
  status: 'planned' | 'publishing' | 'applied' | 'failed' | 'superseded' | 'recovered';
  published_operation_id: string | null; reserved_at: Date | null; lease_until: Date | null;
}
const encoder = new TextEncoder();
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)]));
  return value;
};
const canonical = (value: unknown) => JSON.stringify(sorted(value));
const digestOf = (value: unknown) => sha256Hex(encoder.encode(canonical(value)));
function operatorLabel(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw new ApiError(400, 'invalid_operator_label');
  return value.trim();
}
function cutover(row: CutoverRow): LegacyCutover {
  return { id: row.id, address: row.address, mailboxId: row.mailbox_id, allocationId: row.allocation_id,
    operationId: row.operation_id, phase: row.phase, confirmedOperationId: row.inspection?.policy?.policy.operationId ?? null, stagedAt: row.staged_at?.toISOString() ?? null, stageVerifiedAt: row.stage_verified_at?.toISOString() ?? null,
    stageGatewayId: row.stage_gateway_id, stageWorkerVersion: row.stage_worker_version,
    verifiedAt: row.verified_at?.toISOString() ?? null, gatewayId: row.gateway_id, workerVersion: row.worker_version };
}
function remoteExpectation(inspection: GatewayInspection): RemotePolicyExpectation {
  return inspection.policy ? { revision: inspection.policy.policy.revision, sha256: inspection.policy.sha256 } : { revision: null, sha256: null };
}

/** Local operator capability only. Do not expose this class through user-session HTTP routes. */
export class AddressOperatorService {
  private readonly allowed: ReadonlySet<string>;
  private readonly now: () => number;
  constructor(readonly pool: Pool, config: AddressOperatorConfig, readonly gateway: OperatorGatewayClient) {
    if (!config.allowedAddresses.length) throw new Error('Operator workflows require an explicit address allowlist.');
    this.allowed = new Set(config.allowedAddresses.map((address) => {
      const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
      return normalizeHostedAddress(address, [domain], true);
    }));
    this.now = config.now ?? Date.now;
  }
  private address(input: string): string {
    const address = input.toLowerCase();
    if (!this.allowed.has(address)) throw new ApiError(403, 'operator_address_out_of_scope');
    return address;
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private async audit(client: PoolClient, label: string, allocationId: string, action: string, details: Record<string, unknown> = {}): Promise<void> {
    await client.query('INSERT INTO address_audit_events(id,actor_id,allocation_id,action,details) VALUES ($1,NULL,$2,$3,$4)',
      [randomUUID(), allocationId, action, { ...details, operatorLabel: label }]);
  }
  private async local(client: PoolClient, address: string): Promise<LocalSnapshot> {
    const { rows } = await client.query(`SELECT r.policy_revision, r.current_allocation_id, a.id AS allocation_id,
      a.mailbox_id,a.source,a.receive_only,a.send_generation,m.enabled AS mailbox_enabled,
      legacy.mailbox_id AS legacy_mailbox_id,legacy.enabled AS legacy_enabled,
      EXISTS(SELECT 1 FROM address_holds WHERE allocation_id = a.id AND active AND kind = 'owner') AS owner_paused,
      EXISTS(SELECT 1 FROM address_holds WHERE allocation_id = a.id AND active AND kind = 'admin') AS admin_paused,
      EXISTS(SELECT 1 FROM address_holds WHERE allocation_id = a.id AND active AND kind = 'system') AS system_paused
      FROM address_registry r JOIN address_allocations a ON a.id = COALESCE(r.current_allocation_id,
        (SELECT p.allocation_id FROM address_policy_history p WHERE p.address = r.address ORDER BY p.revision DESC LIMIT 1))
      JOIN mailboxes m ON m.id = a.mailbox_id LEFT JOIN recipient_routes legacy ON lower(legacy.address) = r.address
      WHERE r.address = $1`, [address]);
    const row = rows[0];
    if (!row) throw new ApiError(409, 'operator_allocation_history_required');
    const revision = Number(row.policy_revision), generation = Number(row.send_generation);
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(generation)) throw new ApiError(409, 'operator_revision_invalid');
    return { address, revision, currentAllocationId: row.current_allocation_id, allocationId: row.allocation_id,
      mailboxId: row.mailbox_id, source: row.source, mailboxEnabled: row.mailbox_enabled, receiveOnly: row.receive_only,
      sendingGeneration: generation, ownerPaused: row.owner_paused, adminPaused: row.admin_paused, systemPaused: row.system_paused,
      receiveEnabled: row.current_allocation_id !== null && row.mailbox_enabled && !row.owner_paused && !row.admin_paused && !row.system_paused,
      legacyMailboxId: row.legacy_mailbox_id ?? null, legacyEnabled: row.legacy_enabled ?? null };
  }
  private async lockedLocal(client: PoolClient, address: string): Promise<LocalSnapshot> {
    const initial = await this.local(client, address);
    await client.query('SELECT id FROM mailboxes WHERE id = $1 FOR UPDATE', [initial.mailboxId]);
    await client.query('SELECT address FROM address_registry WHERE address = $1 FOR UPDATE', [address]);
    await client.query('SELECT address FROM recipient_routes WHERE lower(address) = $1 FOR SHARE', [address]);
    const current = await this.local(client, address);
    if (current.mailboxId !== initial.mailboxId) throw new ApiError(409, 'operator_local_state_changed');
    return current;
  }
  private assertLegacy(local: LocalSnapshot): void {
    if (local.source !== 'legacy' || local.currentAllocationId !== local.allocationId || local.legacyMailboxId !== local.mailboxId
      || !local.legacyEnabled || !local.mailboxEnabled || local.ownerPaused || local.adminPaused || local.systemPaused) {
      throw new ApiError(409, 'legacy_cutover_precondition_failed');
    }
  }
  private async storedPolicy(client: PoolClient, operationId: string): Promise<{ policy: RoutePolicy; sha256: string }> {
    const row = (await client.query<{ payload: RoutePolicy; sha256: string }>('SELECT payload,sha256 FROM address_policy_history WHERE operation_id = $1', [operationId])).rows[0];
    if (!row || await hashRoutePolicy(row.payload) !== row.sha256) throw new ApiError(409, 'operator_policy_integrity_error');
    return { policy: row.payload, sha256: row.sha256 };
  }
  private async insertPolicy(client: PoolClient, policy: RoutePolicy, kind: 'legacy_prepare' | 'reconcile'): Promise<void> {
    const sha256 = await hashRoutePolicy(policy);
    await client.query(`INSERT INTO address_policy_history(operation_id,address,allocation_id,mailbox_id,previous_revision,revision,receive_enabled,sha256,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [policy.operationId, policy.address, policy.allocationId, policy.mailboxId, policy.previousRevision, policy.revision, policy.receiveEnabled, sha256, policy]);
    await client.query('INSERT INTO address_policy_outbox(operation_id,dispatch_kind) VALUES ($1,$2)', [policy.operationId, kind]);
    await client.query('UPDATE address_registry SET policy_revision = $2 WHERE address = $1', [policy.address, policy.revision]);
    await client.query(`UPDATE address_policy_outbox o SET status = 'superseded', superseded_at = COALESCE(superseded_at,now()), lease_id = NULL, lease_until = NULL
      FROM address_policy_history h WHERE h.operation_id = o.operation_id AND h.address = $1 AND h.revision < $2
      AND o.status IN ('pending','inflight','blocked','prepared')`, [policy.address, policy.revision]);
  }
  private async recordAppliedPolicy(client: PoolClient, policy: RoutePolicy, status: 'applied' | 'superseded'): Promise<void> {
    const sha256 = await hashRoutePolicy(policy);
    const existing = (await client.query<{ payload: RoutePolicy; sha256: string }>('SELECT payload,sha256 FROM address_policy_history WHERE operation_id = $1', [policy.operationId])).rows[0];
    if (existing && (existing.sha256 !== sha256 || canonical(existing.payload) !== canonical(policy))) throw new ApiError(409, 'operator_policy_history_conflict');
    if (!existing) await client.query(`INSERT INTO address_policy_history(operation_id,address,allocation_id,mailbox_id,previous_revision,revision,receive_enabled,sha256,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [policy.operationId, policy.address, policy.allocationId, policy.mailboxId, policy.previousRevision, policy.revision, policy.receiveEnabled, sha256, policy]);
    await client.query(`INSERT INTO address_policy_outbox(operation_id,dispatch_kind,status,applied_at,superseded_at)
      VALUES ($1,'reconcile',$2,now(),CASE WHEN $2 = 'superseded' THEN now() ELSE NULL END)
      ON CONFLICT (operation_id) DO UPDATE SET status = CASE WHEN address_policy_outbox.status = 'applied' THEN 'applied' ELSE EXCLUDED.status END,
        applied_at = COALESCE(address_policy_outbox.applied_at,now()),lease_id = NULL,lease_until = NULL,last_error_code = NULL`, [policy.operationId, status]);
  }
  async prepareLegacy(input: string, suppliedLabel: string): Promise<LegacyCutover> {
    const address = this.address(input), label = operatorLabel(suppliedLabel);
    return this.transaction(async (client) => {
      const local = await this.lockedLocal(client, address);
      this.assertLegacy(local);
      const existing = (await client.query<CutoverRow>('SELECT * FROM legacy_route_cutovers WHERE address = $1 FOR UPDATE', [address])).rows[0];
      if (existing) {
        const stored = await this.storedPolicy(client, existing.operation_id);
        if (existing.mailbox_id !== local.mailboxId || existing.allocation_id !== local.allocationId || stored.policy.revision !== local.revision) throw new ApiError(409, 'operator_local_state_changed');
        return cutover(existing);
      }
      if (local.revision !== 0) throw new ApiError(409, 'legacy_policy_already_exists');
      const policy: RoutePolicy = { version: 1, operationId: randomUUID(), address, allocationId: local.allocationId,
        mailboxId: local.mailboxId, previousRevision: 0, revision: 1, receiveEnabled: true };
      await this.insertPolicy(client, policy, 'legacy_prepare');
      const row = (await client.query<CutoverRow>(`INSERT INTO legacy_route_cutovers(id,address,mailbox_id,allocation_id,operation_id,prepared_by)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), address, local.mailboxId, local.allocationId, policy.operationId, label])).rows[0]!;
      await this.audit(client, label, local.allocationId, 'operator.legacy_prepared', { operationId: policy.operationId, cutoverId: row.id });
      return cutover(row);
    });
  }
  async stageLegacy(operationId: string, suppliedLabel: string): Promise<LegacyCutover> {
    const id = requireUuid(operationId), label = operatorLabel(suppliedLabel), lease = randomUUID();
    const candidate = (await this.pool.query<CutoverRow>('SELECT * FROM legacy_route_cutovers WHERE operation_id = $1', [id])).rows[0];
    if (!candidate) throw new ApiError(404, 'legacy_cutover_not_found');
    const address = this.address(candidate.address);
    const stored = await this.transaction(async (client) => {
      const local = await this.lockedLocal(client, address); this.assertLegacy(local);
      const row = (await client.query<CutoverRow>('SELECT * FROM legacy_route_cutovers WHERE operation_id = $1 FOR UPDATE', [id])).rows[0]!;
      if (row.phase !== 'prepared') throw new ApiError(409, 'legacy_already_dynamic');
      const record = await this.storedPolicy(client, id);
      if (record.policy.revision !== local.revision || record.policy.allocationId !== local.allocationId) throw new ApiError(409, 'operator_local_state_changed');
      const result = await client.query(`UPDATE address_policy_outbox SET status = 'inflight',attempts = attempts + 1,
        lease_id = $2,lease_until = now() + interval '1 minute' WHERE operation_id = $1 AND dispatch_kind = 'legacy_prepare'
        AND status IN ('pending','prepared','blocked','inflight') AND (lease_until IS NULL OR lease_until <= now()) RETURNING operation_id`, [id, lease]);
      if (!result.rowCount) throw new ApiError(409, 'operator_operation_in_progress');
      return record;
    });
    try {
      const ack = await this.gateway.stage(stored.policy);
      if (ack.status !== 'prepared' || !matchesPolicyAck({ ...ack, status: 'applied' }, { ...stored.policy, sha256: stored.sha256 })) throw new ApiError(409, 'operator_prepared_ack_mismatch');
      return await this.transaction(async (client) => {
        const local = await this.lockedLocal(client, address); this.assertLegacy(local);
        if (local.revision !== stored.policy.revision) throw new ApiError(409, 'operator_local_state_changed');
        const updated = await client.query(`UPDATE address_policy_outbox SET status = 'prepared',lease_id = NULL,lease_until = NULL,last_error_code = NULL
          WHERE operation_id = $1 AND lease_id = $2 AND status = 'inflight' RETURNING operation_id`, [id, lease]);
        if (!updated.rowCount) throw new ApiError(409, 'operator_lease_changed');
        const row = (await client.query<CutoverRow>('UPDATE legacy_route_cutovers SET staged_at = COALESCE(staged_at,now()) WHERE operation_id = $1 RETURNING *', [id])).rows[0]!;
        await this.audit(client, label, local.allocationId, 'operator.legacy_staged', { operationId: id });
        return cutover(row);
      });
    } catch (error) {
      await this.pool.query(`UPDATE address_policy_outbox SET status = 'pending',lease_id = NULL,lease_until = NULL,last_error_code = 'legacy_stage_failed'
        WHERE operation_id = $1 AND lease_id = $2`, [id, lease]);
      throw error;
    }
  }
  private async inspect(value: GatewayInspection, address: string, gatewayId: string, workerVersion: string): Promise<GatewayInspection> {
    const inspected = validateGatewayInspection(value);
    if (!gatewayId || !workerVersion || inspected.address !== address || inspected.gatewayId !== gatewayId || inspected.workerVersion !== workerVersion) throw new ApiError(409, 'operator_gateway_scope_mismatch');
    if (inspected.inspectedAt > this.now() + 5000 || this.now() - inspected.inspectedAt > 60_000) throw new ApiError(409, 'operator_inspection_stale');
    if (inspected.policy && await hashRoutePolicy(inspected.policy.policy) !== inspected.policy.sha256) throw new ApiError(409, 'operator_policy_integrity_error');
    return inspected;
  }
  private policyScope(inspection: GatewayInspection): void {
    const actual = inspection.policyAllowedAddresses;
    if (!actual || canonical([...actual].sort()) !== canonical([...this.allowed].sort())) throw new ApiError(409, 'operator_gateway_policy_scope_mismatch');
  }
  private async noPreparedCutover(db: Pick<Pool, 'query'>, address: string): Promise<void> {
    const pending = await db.query("SELECT 1 FROM legacy_route_cutovers WHERE address = $1 AND phase = 'prepared'", [address]);
    if (pending.rowCount) throw new ApiError(409, 'legacy_cutover_not_confirmed');
  }
  async verifyStaged(input: string, gatewayId: string, workerVersion: string, suppliedLabel: string): Promise<LegacyCutover> {
    const address = this.address(input), label = operatorLabel(suppliedLabel);
    const observed = await this.inspect(await this.gateway.inspect(address), address, gatewayId, workerVersion);
    this.policyScope(observed);
    if (observed.routingMode !== 'static') throw new ApiError(409, 'gateway_not_static');
    return this.transaction(async (client) => {
      const local = await this.lockedLocal(client, address); this.assertLegacy(local);
      await this.inspect(observed, address, gatewayId, workerVersion);
      const row = (await client.query<CutoverRow>('SELECT * FROM legacy_route_cutovers WHERE address = $1 FOR UPDATE', [address])).rows[0];
      if (!row) throw new ApiError(404, 'legacy_cutover_not_found');
      if (row.phase !== 'prepared') throw new ApiError(409, 'legacy_already_dynamic');
      const stored = await this.storedPolicy(client, row.operation_id);
      if (observed.staticMailboxId !== row.mailbox_id || local.allocationId !== row.allocation_id || local.revision !== stored.policy.revision
        || !observed.policy || canonical(observed.policy.policy) !== canonical(stored.policy) || observed.policy.sha256 !== stored.sha256) throw new ApiError(409, 'operator_policy_confirmation_mismatch');
      if (row.stage_verified_at) {
        if (row.stage_gateway_id !== gatewayId || row.stage_worker_version !== workerVersion) throw new ApiError(409, 'operator_gateway_scope_mismatch');
        return cutover(row);
      }
      const updated = (await client.query<CutoverRow>(`UPDATE legacy_route_cutovers SET staged_at = COALESCE(staged_at,now()),stage_verified_at = now(),
        stage_gateway_id = $2,stage_worker_version = $3,stage_inspection_request_id = $4,stage_inspection_sha256 = $5,stage_inspection = $6 WHERE id = $1 RETURNING *`,
      [row.id, gatewayId, workerVersion, observed.requestId, await digestOf(observed), observed])).rows[0]!;
      await client.query("UPDATE address_policy_outbox SET status = 'prepared',lease_id = NULL,lease_until = NULL,last_error_code = NULL WHERE operation_id = $1", [row.operation_id]);
      await this.audit(client, label, local.allocationId, 'operator.legacy_stage_verified', { cutoverId: row.id, requestId: observed.requestId });
      return cutover(updated);
    });
  }
  async markDynamicCompatibility(input: string, expected: GatewayInspection, gatewayId: string, workerVersion: string, suppliedLabel: string): Promise<LegacyCutover> {
    const address = this.address(input), label = operatorLabel(suppliedLabel);
    const initial = (await this.pool.query<CutoverRow>('SELECT * FROM legacy_route_cutovers WHERE address = $1', [address])).rows[0];
    if (!initial) throw new ApiError(404, 'legacy_cutover_not_found');
    if (!initial.stage_verified_at) throw new ApiError(409, 'legacy_stage_verification_required');
    if (initial.phase === 'dynamic_compatibility') {
      this.policyScope(expected);
      if (gatewayId !== initial.gateway_id || workerVersion !== initial.worker_version || expected.address !== address
        || expected.gatewayId !== gatewayId || expected.workerVersion !== workerVersion) throw new ApiError(409, 'operator_gateway_scope_mismatch');
      // This is the original recorded evidence, not a refreshed declaration about the current deployment.
      return cutover(initial);
    }
    await this.inspect(expected, address, gatewayId, workerVersion); this.policyScope(expected);
    const observed = await this.inspect(await this.gateway.inspect(address), address, gatewayId, workerVersion); this.policyScope(observed);
    if (expected.routingMode !== 'dynamic' || observed.routingMode !== 'dynamic') throw new ApiError(409, 'gateway_not_dynamic');
    if (canonical(remoteExpectation(expected)) !== canonical(remoteExpectation(observed))) throw new ApiError(409, 'operator_remote_state_changed');
    return this.transaction(async (client) => {
      const local = await this.lockedLocal(client, address); this.assertLegacy(local);
      await this.inspect(observed, address, gatewayId, workerVersion);
      const row = (await client.query<CutoverRow>('SELECT * FROM legacy_route_cutovers WHERE address = $1 FOR UPDATE', [address])).rows[0]!;
      if (!row.stage_verified_at || row.stage_gateway_id !== gatewayId) throw new ApiError(409, 'legacy_stage_verification_required');
      if (row.phase === 'dynamic_compatibility') {
        if (row.gateway_id !== gatewayId || row.worker_version !== workerVersion) throw new ApiError(409, 'operator_gateway_scope_mismatch');
        return cutover(row);
      }
      const stored = await this.storedPolicy(client, row.operation_id);
      if (!observed.policy || canonical(observed.policy.policy) !== canonical(stored.policy) || observed.policy.sha256 !== stored.sha256
        || local.revision !== stored.policy.revision || local.allocationId !== row.allocation_id || local.mailboxId !== row.mailbox_id
        || !stored.policy.receiveEnabled) throw new ApiError(409, 'operator_policy_confirmation_mismatch');
      await client.query(`UPDATE address_policy_outbox SET status = 'applied',applied_at = COALESCE(applied_at,now()),lease_id = NULL,lease_until = NULL,last_error_code = NULL WHERE operation_id = $1`, [row.operation_id]);
      const updated = (await client.query<CutoverRow>(`UPDATE legacy_route_cutovers SET phase = 'dynamic_compatibility',verified_at = now(),
        gateway_id = $2,worker_version = $3,inspection_request_id = $4,inspection_sha256 = $5,inspection = $6 WHERE id = $1 RETURNING *`,
      [row.id, gatewayId, workerVersion, observed.requestId, await digestOf(observed), observed])).rows[0]!;
      await this.audit(client, label, local.allocationId, 'operator.dynamic_compatibility', { cutoverId: row.id, requestId: observed.requestId, confirmedOperationId: row.operation_id });
      return cutover(updated);
    });
  }
  async planReconciliation(input: string, gatewayId: string, workerVersion: string, suppliedLabel: string): Promise<PolicyReconciliationPlan> {
    const address = this.address(input), label = operatorLabel(suppliedLabel);
    await this.noPreparedCutover(this.pool, address);
    const observed = await this.inspect(await this.gateway.inspect(address), address, gatewayId, workerVersion);
    if (observed.routingMode !== 'dynamic') throw new ApiError(409, 'gateway_not_dynamic');
    return this.transaction(async (client) => {
      const local = await this.lockedLocal(client, address);
      await this.inspect(observed, address, gatewayId, workerVersion);
      await this.noPreparedCutover(client, address);
      if (observed.policy && (observed.policy.policy.allocationId !== local.allocationId || observed.policy.policy.mailboxId !== local.mailboxId)) throw new ApiError(409, 'operator_remote_binding_mismatch');
      const next = Math.max(local.revision, observed.policy?.policy.revision ?? 0) + 1;
      if (!Number.isSafeInteger(next)) throw new ApiError(409, 'operator_revision_exhausted');
      const plan: Omit<PolicyReconciliationPlan, 'digest'> = {
        version: 1, planId: randomUUID(), address, operatorLabel: label, createdAt: this.now(), expiresAt: this.now() + 5 * 60_000,
        gatewayId, workerVersion, expectedLocal: local, expectedRemote: remoteExpectation(observed), remoteInspection: observed,
        policy: { version: 1, operationId: randomUUID(), address, allocationId: local.allocationId, mailboxId: local.mailboxId,
          previousRevision: next - 1, revision: next, receiveEnabled: local.receiveEnabled },
      };
      const digest = await digestOf(plan);
      await client.query('INSERT INTO address_operator_plans(id,address,plan_sha256,plan_json,expires_at) VALUES ($1,$2,$3,$4,$5)', [plan.planId, address, digest, plan, new Date(plan.expiresAt)]);
      await this.audit(client, label, local.allocationId, 'operator.reconciliation_planned', { planId: plan.planId, digest });
      return { ...plan, digest };
    });
  }
  async applyReconciliation(planId: string, expectedDigest: string, suppliedLabel: string): Promise<{ planId: string; operationId: string; status: string }> {
    const id = requireUuid(planId), label = operatorLabel(suppliedLabel), lease = randomUUID();
    const initial = (await this.pool.query<PlanRow>('SELECT * FROM address_operator_plans WHERE id = $1', [id])).rows[0];
    if (!initial) throw new ApiError(404, 'operator_plan_not_found');
    const address = this.address(initial.address), plan = initial.plan_json;
    if (initial.plan_sha256 !== expectedDigest || await digestOf(plan) !== expectedDigest) throw new ApiError(409, 'operator_plan_digest_mismatch');
    await this.noPreparedCutover(this.pool, address);
    if (initial.status === 'recovered') throw new ApiError(409, 'operator_plan_already_finished');
    if (initial.status === 'applied') return { planId: id, operationId: plan.policy.operationId, status: 'applied' };
    if (plan.expiresAt <= this.now()) throw new ApiError(409, 'operator_plan_expired');
    const observed = await this.inspect(await this.gateway.inspect(address), address, plan.gatewayId, plan.workerVersion);
    if (observed.routingMode !== 'dynamic') throw new ApiError(409, 'gateway_not_dynamic');
    const policyDigest = await hashRoutePolicy(plan.policy);
    const alreadyRemote = observed.policy?.sha256 === policyDigest && canonical(observed.policy.policy) === canonical(plan.policy);
    if (!alreadyRemote && canonical(remoteExpectation(observed)) !== canonical(plan.expectedRemote)) throw new ApiError(409, 'operator_remote_state_changed');
    await this.transaction(async (client) => {
      const local = await this.lockedLocal(client, address);
      const row = (await client.query<PlanRow>('SELECT * FROM address_operator_plans WHERE id = $1 FOR UPDATE', [id])).rows[0]!;
      await this.noPreparedCutover(client, address);
      if (plan.expiresAt <= this.now()) throw new ApiError(409, 'operator_plan_expired');
      await this.inspect(observed, address, plan.gatewayId, plan.workerVersion);
      if (row.lease_until && row.lease_until.getTime() > this.now()) throw new ApiError(409, 'operator_operation_in_progress');
      if (row.status === 'superseded' || row.status === 'applied' || row.status === 'recovered') throw new ApiError(409, 'operator_plan_already_finished');
      if (row.reserved_at) {
        // Exact authenticated readback can recover historical evidence even after a newer local pause won.
        if (alreadyRemote) {
          if (local.revision < plan.policy.revision) throw new ApiError(409, 'operator_local_state_changed');
        } else if (local.revision !== plan.policy.revision || local.allocationId !== plan.policy.allocationId
          || local.receiveEnabled !== plan.policy.receiveEnabled || local.sendingGeneration !== plan.expectedLocal.sendingGeneration) {
          throw new ApiError(409, 'operator_local_state_changed');
        }
      } else {
        if (canonical(local) !== canonical(plan.expectedLocal)) throw new ApiError(409, 'operator_local_state_changed');
        // Reserve the local revision before network I/O. No admission history exists until a verified ACK/readback.
        await client.query('UPDATE address_registry SET policy_revision = $2 WHERE address = $1', [address, plan.policy.revision]);
        await client.query(`UPDATE address_policy_outbox o SET status = 'superseded',superseded_at = COALESCE(superseded_at,now()),lease_id = NULL,lease_until = NULL
          FROM address_policy_history h WHERE h.operation_id = o.operation_id AND h.address = $1 AND h.revision < $2
          AND o.status IN ('pending','inflight','blocked','prepared')`, [address, plan.policy.revision]);
      }
      await client.query(`UPDATE address_operator_plans SET status = 'publishing',reserved_at = COALESCE(reserved_at,now()),lease_token = $2,
        lease_until = $3,last_error_code = NULL WHERE id = $1`, [id, lease, new Date(this.now() + 60_000)]);
    });
    try {
      const ack: PolicyAck = alreadyRemote
        ? { version: 1, operationId: plan.policy.operationId, address, revision: plan.policy.revision, sha256: policyDigest, status: 'applied' }
        : await this.gateway.reconcile(plan.policy, plan.expectedRemote);
      if (!matchesPolicyAck(ack, { ...plan.policy, sha256: policyDigest })) throw new ApiError(409, 'operator_reconciliation_ack_mismatch');
      return await this.transaction(async (client) => {
        const local = await this.lockedLocal(client, address);
        const status = local.revision === plan.policy.revision && local.allocationId === plan.policy.allocationId && local.receiveEnabled === plan.policy.receiveEnabled ? 'applied' : 'superseded';
        await this.recordAppliedPolicy(client, plan.policy, status);
        const updated = await client.query(`UPDATE address_operator_plans SET status = $3,published_operation_id = $4,applied_at = now(),lease_token = NULL,lease_until = NULL,last_error_code = NULL
          WHERE id = $1 AND lease_token = $2 RETURNING id`, [id, lease, status, plan.policy.operationId]);
        if (!updated.rowCount) throw new ApiError(409, 'operator_lease_changed');
        await this.audit(client, label, plan.policy.allocationId, 'operator.reconciliation_acknowledged', { planId: id, operationId: plan.policy.operationId, status });
        return { planId: id, operationId: plan.policy.operationId, status };
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[a-z][a-z0-9_]{0,99}$/.test(error.code) ? error.code : 'reconciliation_failed';
      await this.transaction(async (client) => {
        await client.query(`UPDATE address_operator_plans SET status = 'failed',lease_token = NULL,lease_until = NULL,last_error_code = $3 WHERE id = $1 AND lease_token = $2`, [id, lease, code]);

      });
      throw error;
    }
  }
  /** Read-only gateway evidence recovery. Expiration still gates every cloud-writing apply operation. */
  async recoverReconciliation(planId: string, expectedDigest: string, suppliedLabel: string): Promise<{ planId: string; operationId: string; status: string }> {
    const id = requireUuid(planId), label = operatorLabel(suppliedLabel);
    const initial = (await this.pool.query<PlanRow>('SELECT * FROM address_operator_plans WHERE id = $1', [id])).rows[0];
    if (!initial) throw new ApiError(404, 'operator_plan_not_found');
    const plan = initial.plan_json, address = this.address(initial.address);
    if (initial.plan_sha256 !== expectedDigest || await digestOf(plan) !== expectedDigest) throw new ApiError(409, 'operator_plan_digest_mismatch');
    const evidence = await this.gateway.operationStatus(address, plan.policy.operationId);
    requireUuid(evidence.requestId);
    if (evidence.version !== 1 || evidence.kind !== 'operation-status' || evidence.address !== address
      || evidence.operationId !== plan.policy.operationId || evidence.gatewayId !== plan.gatewayId) throw new ApiError(409, 'operator_gateway_scope_mismatch');
    if (!Number.isSafeInteger(evidence.inspectedAt) || evidence.inspectedAt > this.now() + 5000 || this.now() - evidence.inspectedAt > 60_000) throw new ApiError(409, 'operator_inspection_stale');
    if (!evidence.record) throw new ApiError(409, 'operator_remote_operation_not_found');
    const expectedPolicyDigest = await hashRoutePolicy(plan.policy);
    if (canonical(evidence.record.policy) !== canonical(plan.policy) || evidence.record.sha256 !== expectedPolicyDigest
      || await hashRoutePolicy(evidence.record.policy) !== expectedPolicyDigest || !Number.isSafeInteger(evidence.record.appliedAt)
      || evidence.record.appliedAt < 0 || evidence.record.appliedAt > evidence.inspectedAt + 5000) throw new ApiError(409, 'operator_policy_confirmation_mismatch');
    return this.transaction(async (client) => {
      // Validate the historical allocation itself, not the address's current owner or current enabled state.
      const mailbox = await client.query('SELECT id FROM mailboxes WHERE id = $1 FOR UPDATE', [plan.policy.mailboxId]);
      if (!mailbox.rowCount) throw new ApiError(409, 'operator_allocation_history_required');
      await client.query('SELECT address FROM address_registry WHERE address = $1 FOR UPDATE', [address]);
      const allocation = await client.query('SELECT 1 FROM address_allocations WHERE id = $1 AND address = $2 AND mailbox_id = $3',
        [plan.policy.allocationId, address, plan.policy.mailboxId]);
      if (!allocation.rowCount) throw new ApiError(409, 'operator_allocation_history_required');
      const row = (await client.query<PlanRow>('SELECT * FROM address_operator_plans WHERE id = $1 FOR UPDATE', [id])).rows[0]!;
      if (row.lease_until && row.lease_until.getTime() > this.now()) throw new ApiError(409, 'operator_operation_in_progress');
      if (this.now() - evidence.inspectedAt > 60_000) throw new ApiError(409, 'operator_inspection_stale');
      const collision = await client.query<{ operation_id: string; sha256: string }>('SELECT operation_id,sha256 FROM address_policy_history WHERE address = $1 AND revision = $2', [address, plan.policy.revision]);
      if (collision.rows[0] && (collision.rows[0].operation_id !== plan.policy.operationId || collision.rows[0].sha256 !== expectedPolicyDigest)) throw new ApiError(409, 'operator_policy_history_conflict');
      // Newly recovered evidence is historical only, even when its revision equals the registry's current value.
      await this.recordAppliedPolicy(client, plan.policy, 'superseded');
      const status = row.status === 'applied' ? 'applied' : 'recovered';
      await client.query(`UPDATE address_operator_plans SET status = $2,published_operation_id = $3,lease_token = NULL,lease_until = NULL,last_error_code = NULL,
        recovered_at = COALESCE(recovered_at,now()),recovery_sha256 = COALESCE(recovery_sha256,$4),
        recovery_evidence = COALESCE(recovery_evidence,$5),recovered_by = COALESCE(recovered_by,$6) WHERE id = $1`,
      [id, status, plan.policy.operationId, await digestOf(evidence), evidence, label]);
      await this.audit(client, label, plan.policy.allocationId, 'operator.reconciliation_evidence_recovered',
        { planId: id, operationId: plan.policy.operationId, requestId: evidence.requestId, status });
      return { planId: id, operationId: plan.policy.operationId, status };
    });
  }

}
