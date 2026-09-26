import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashRoutePolicy, type GatewayInspection, type GatewayOperationStatus, type PolicyAck, type PreparedPolicyAck, type RemotePolicyExpectation, type RoutePolicy } from '@dreampost/protocol';
import { migrate, seedMailbox } from '../src/database.js';
import { AddressOperatorService, type OperatorGatewayClient } from '../src/addresses/operator.js';
import { dispatchOnePolicy } from '../src/addresses/dispatcher.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const address = 'legacy@example.test';
const gatewayId = 'operator-test';
const workerVersion = 'test-version';
const label = 'local-maintenance-test';

class FakeGateway implements OperatorGatewayClient {
  policy: GatewayInspection['policy'] = null;
  mode: 'static' | 'dynamic' = 'static';
  gatewayId = gatewayId;
  workerVersion: string | null = workerVersion;
  inspectedAtOffset = 0;
  policyAllowedAddresses: string[] | null = [address];
  records = new Map<string, NonNullable<GatewayOperationStatus['record']>>();
  operationReads: string[] = [];
  stages: RoutePolicy[] = [];
  reconciliations: Array<{ policy: RoutePolicy; expectedRemote: RemotePolicyExpectation }> = [];
  beforeReconcile?: () => Promise<void>;
  loseReconcileResponse = false;
  constructor(readonly mailboxId: string, readonly now: () => number) {}
  async inspect(requested: string): Promise<GatewayInspection> {
    return { version: 1, kind: 'inspection', requestId: randomUUID(), address: requested, gatewayId: this.gatewayId,
      workerVersion: this.workerVersion, routingMode: this.mode, inspectedAt: this.now() + this.inspectedAtOffset,
      staticMailboxId: this.mailboxId, policyAllowedAddresses: this.policyAllowedAddresses, policy: structuredClone(this.policy),
      states: { receiving: 0, stored: 0, blocked: 0, delivered_pending_delete: 0, done: 0 },
      legacyPending: 0, activeLeases: 0, receipts: [], nextCursor: null };
  }
  async setPolicy(policy: RoutePolicy) {
    this.policy = { policy, sha256: await hashRoutePolicy(policy) };
    this.records.set(policy.operationId, { ...structuredClone(this.policy), appliedAt: this.now() });
  }
  async operationStatus(requested: string, operationId: string): Promise<GatewayOperationStatus> {
    this.operationReads.push(operationId);
    return { version: 1, kind: 'operation-status', requestId: randomUUID(), address: requested, gatewayId: this.gatewayId,
      workerVersion: this.workerVersion, inspectedAt: this.now() + this.inspectedAtOffset, operationId,
      record: structuredClone(this.records.get(operationId) ?? null) };
  }
  async stage(policy: RoutePolicy): Promise<PreparedPolicyAck> {
    if (this.mode !== 'static') throw new Error('static_preparation_required');
    this.stages.push(structuredClone(policy));
    await this.setPolicy(policy);
    return { version: 1, operationId: policy.operationId, address: policy.address, revision: policy.revision, sha256: this.policy!.sha256, status: 'prepared' };
  }
  async reconcile(policy: RoutePolicy, expectedRemote: RemotePolicyExpectation): Promise<PolicyAck> {
    this.reconciliations.push({ policy: structuredClone(policy), expectedRemote: structuredClone(expectedRemote) });
    await this.beforeReconcile?.();
    const current = this.policy ? { revision: this.policy.policy.revision, sha256: this.policy.sha256 } : { revision: null, sha256: null };
    if (current.revision !== expectedRemote.revision || current.sha256 !== expectedRemote.sha256) throw new Error('policy_precondition_failed');
    await this.setPolicy(policy);
    if (this.loseReconcileResponse) throw new Error('lost_response');
    return { version: 1, operationId: policy.operationId, address: policy.address, revision: policy.revision, sha256: this.policy!.sha256, status: 'applied' };
  }
}

it('requires an explicit local operator address scope', () => {
  expect(() => new AddressOperatorService({} as pg.Pool, { allowedAddresses: [] }, {} as OperatorGatewayClient)).toThrow('explicit address allowlist');
});

describe.skipIf(!databaseUrl)('local operator address workflows', () => {
  const schema = `address_operator_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let mailboxId: string;
  let allocationId: string;
  let clock: number;
  let gateway: FakeGateway;
  let operator: AddressOperatorService;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE mailboxes, principals CASCADE');
    clock = Date.now(); mailboxId = randomUUID(); allocationId = randomUUID();
    await seedMailbox(pool, { id: mailboxId, address, name: 'Legacy mailbox' });
    await pool.query("INSERT INTO address_registry(address,domain,state) VALUES ($1,'example.test','allocated')", [address]);
    await pool.query("INSERT INTO address_allocations(id,address,mailbox_id,source,receive_only) VALUES ($1,$2,$3,'legacy',true)", [allocationId, address, mailboxId]);
    await pool.query('UPDATE address_registry SET current_allocation_id = $2 WHERE address = $1', [address, allocationId]);
    gateway = new FakeGateway(mailboxId, () => clock);
    operator = new AddressOperatorService(pool, { allowedAddresses: [address], now: () => clock }, gateway);
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  async function dynamic() {
    const prepared = await operator.prepareLegacy(address, label);
    await operator.stageLegacy(prepared.operationId, label);
    await operator.verifyStaged(address, gatewayId, workerVersion, label);
    gateway.mode = 'dynamic';
    await operator.markDynamicCompatibility(address, await gateway.inspect(address), gatewayId, workerVersion, label);
    return prepared;
  }
  async function legacyUntouched() {
    expect((await pool.query('SELECT enabled,mailbox_id FROM recipient_routes WHERE address = $1', [address])).rows).toEqual([{ enabled: true, mailbox_id: mailboxId }]);
    expect((await pool.query('SELECT owner_principal_id FROM mailboxes WHERE id = $1', [mailboxId])).rows[0].owner_principal_id).toBeNull();
    expect((await pool.query('SELECT count(*) FROM address_send_grants')).rows[0].count).toBe('0');
  }

  it('prepares idempotently without a user principal, preserves the legacy tuple, and excludes preload from normal dispatch', async () => {
    const first = await operator.prepareLegacy(address, label);
    expect((await operator.prepareLegacy(address, label)).operationId).toBe(first.operationId);
    const fetcher = vi.fn<typeof fetch>();
    expect(await dispatchOnePolicy({ pool } as Parameters<typeof dispatchOnePolicy>[0], {
      gatewayUrl: 'https://edge.example.test/internal/v1/recipient-policies', key: { id: 'test', secret: 'test-policy-secret-at-least-32-bytes' }, fetch: fetcher,
    })).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    await operator.stageLegacy(first.operationId, label);
    expect(gateway.stages.map((item) => item.operationId)).toEqual([first.operationId]);
    expect((await pool.query('SELECT status,dispatch_kind FROM address_policy_outbox')).rows).toEqual([{ status: 'prepared', dispatch_kind: 'legacy_prepare' }]);
    expect((await pool.query('SELECT actor_id,details FROM address_audit_events')).rows.every((row) => row.actor_id === null && row.details.operatorLabel === label)).toBe(true);
    await legacyUntouched();
  });

  it('rejects out-of-scope addresses, blank labels, disabled legacy routes and active holds before publication', async () => {
    await expect(operator.prepareLegacy('outside@example.test', label)).rejects.toMatchObject({ code: 'operator_address_out_of_scope' });
    await expect(operator.prepareLegacy(address, '')).rejects.toMatchObject({ code: 'invalid_operator_label' });
    await pool.query('UPDATE recipient_routes SET enabled = false WHERE address = $1', [address]);
    await expect(operator.prepareLegacy(address, label)).rejects.toMatchObject({ code: 'legacy_cutover_precondition_failed' });
    await pool.query('UPDATE recipient_routes SET enabled = true WHERE address = $1', [address]);
    await pool.query("INSERT INTO address_holds(allocation_id,kind,active) VALUES ($1,'system',true)", [allocationId]);
    await expect(operator.prepareLegacy(address, label)).rejects.toMatchObject({ code: 'legacy_cutover_precondition_failed' });
    expect((await pool.query('SELECT count(*) FROM address_policy_history')).rows[0].count).toBe('0');
  });

  it('requires exact dynamic gateway version and fresh verified-client observation before recording compatibility', async () => {
    const prepared = await operator.prepareLegacy(address, label);
    await operator.stageLegacy(prepared.operationId, label);
    await expect(operator.markDynamicCompatibility(address, await gateway.inspect(address), gatewayId, workerVersion, label)).rejects.toMatchObject({ code: 'legacy_stage_verification_required' });
    await operator.verifyStaged(address, gatewayId, workerVersion, label);
    const staticInspection = await gateway.inspect(address);
    await expect(operator.markDynamicCompatibility(address, staticInspection, gatewayId, workerVersion, label)).rejects.toMatchObject({ code: 'gateway_not_dynamic' });
    gateway.mode = 'dynamic';
    const expected = await gateway.inspect(address);
    await expect(operator.markDynamicCompatibility(address, expected, 'wrong-gateway', workerVersion, label)).rejects.toMatchObject({ code: 'operator_gateway_scope_mismatch' });
    await expect(operator.markDynamicCompatibility(address, expected, gatewayId, 'wrong-version', label)).rejects.toMatchObject({ code: 'operator_gateway_scope_mismatch' });
    await expect(operator.markDynamicCompatibility(address, { ...expected, inspectedAt: clock - 61_000 }, gatewayId, workerVersion, label)).rejects.toMatchObject({ code: 'operator_inspection_stale' });
    gateway.mode = 'static';
    await expect(operator.markDynamicCompatibility(address, expected, gatewayId, workerVersion, label)).rejects.toMatchObject({ code: 'gateway_not_dynamic' });
    gateway.mode = 'dynamic';
    const confirmed = await operator.markDynamicCompatibility(address, expected, gatewayId, workerVersion, label);
    expect(confirmed.phase).toBe('dynamic_compatibility');
    expect((await pool.query('SELECT status FROM address_policy_outbox WHERE operation_id = $1', [prepared.operationId])).rows[0].status).toBe('applied');
    await legacyUntouched();
  });

  it('requires an explicit immutable plan digest and repairs remote-ahead state only with the observed CAS', async () => {
    await dynamic();
    await gateway.setPolicy({ ...gateway.policy!.policy, operationId: randomUUID(), previousRevision: 7, revision: 8 });
    const plan = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    expect(plan.policy.revision).toBe(9);
    expect(plan.expectedRemote).toEqual({ revision: 8, sha256: gateway.policy!.sha256 });
    await expect(operator.applyReconciliation(plan.planId, '0'.repeat(64), label)).rejects.toMatchObject({ code: 'operator_plan_digest_mismatch' });
    await expect(pool.query("UPDATE address_operator_plans SET plan_json = '{}' WHERE id = $1", [plan.planId])).rejects.toThrow('immutable');
    expect((await operator.applyReconciliation(plan.planId, plan.digest, label)).status).toBe('applied');
    expect(gateway.reconciliations).toHaveLength(1);
    expect(gateway.reconciliations[0]?.expectedRemote).toEqual(plan.expectedRemote);
    expect(gateway.policy!.policy.mailboxId).toBe(mailboxId);
    expect((await operator.applyReconciliation(plan.planId, plan.digest, label)).status).toBe('applied');
    expect(gateway.reconciliations).toHaveLength(1);
    await legacyUntouched();
  });

  it('blocks policy planning and application while the initial legacy preparation is unconfirmed', async () => {
    gateway.mode = 'dynamic';
    const olderPlan = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    gateway.mode = 'static';
    const prepared = await operator.prepareLegacy(address, label);
    await operator.stageLegacy(prepared.operationId, label);
    await operator.verifyStaged(address, gatewayId, workerVersion, label);
    gateway.mode = 'dynamic';
    await expect(operator.planReconciliation(address, gatewayId, workerVersion, label)).rejects.toMatchObject({ code: 'legacy_cutover_not_confirmed' });
    await expect(operator.applyReconciliation(olderPlan.planId, olderPlan.digest, label)).rejects.toMatchObject({ code: 'legacy_cutover_not_confirmed' });
    expect(gateway.reconciliations).toHaveLength(0);
    const confirmed = await operator.markDynamicCompatibility(address, await gateway.inspect(address), gatewayId, workerVersion, label);
    expect(confirmed.confirmedOperationId).toBe(prepared.operationId);
    await legacyUntouched();
  });

  it('pins immutable static and dynamic proofs separately and rejects wider policy scope', async () => {
    const prepared = await operator.prepareLegacy(address, label);
    await operator.stageLegacy(prepared.operationId, label);
    for (const scope of [null, [address, 'unapproved@example.test'], [address, address]]) {
      gateway.policyAllowedAddresses = scope;
      await expect(operator.verifyStaged(address, gatewayId, workerVersion, label)).rejects.toMatchObject({ code: 'operator_gateway_policy_scope_mismatch' });
    }
    gateway.policyAllowedAddresses = [address];
    const stage = await operator.verifyStaged(address, gatewayId, workerVersion, label);
    expect(stage.stageVerifiedAt).toBeTruthy();
    await expect(pool.query("UPDATE legacy_route_cutovers SET stage_worker_version = 'changed' WHERE address = $1", [address])).rejects.toThrow('immutable');
    gateway.mode = 'dynamic'; gateway.workerVersion = 'dynamic-v2';
    gateway.policyAllowedAddresses = [address, 'unapproved@example.test'];
    await expect(operator.markDynamicCompatibility(address, await gateway.inspect(address), gatewayId, 'dynamic-v2', label)).rejects.toMatchObject({ code: 'operator_gateway_policy_scope_mismatch' });
    gateway.policyAllowedAddresses = [address];
    const confirmed = await operator.markDynamicCompatibility(address, await gateway.inspect(address), gatewayId, 'dynamic-v2', label);
    expect(confirmed.stageWorkerVersion).toBe(workerVersion);
    expect(confirmed.workerVersion).toBe('dynamic-v2');
    clock += 1000;
    expect(await operator.markDynamicCompatibility(address, await gateway.inspect(address), gatewayId, 'dynamic-v2', label)).toEqual(confirmed);
    await expect(pool.query("UPDATE legacy_route_cutovers SET worker_version = 'changed' WHERE address = $1", [address])).rejects.toThrow('immutable');
    gateway.workerVersion = 'dynamic-v3';
    await expect(operator.markDynamicCompatibility(address, await gateway.inspect(address), gatewayId, 'dynamic-v3', label)).rejects.toMatchObject({ code: 'operator_gateway_scope_mismatch' });
  });

  it('refuses expired plans, changed local holds, and unrecognized remote ownership', async () => {
    await dynamic();
    const expired = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    clock += 301_000;
    await expect(operator.applyReconciliation(expired.planId, expired.digest, label)).rejects.toMatchObject({ code: 'operator_plan_expired' });
    const changed = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    await pool.query("INSERT INTO address_holds(allocation_id,kind,active) VALUES ($1,'system',true)", [allocationId]);
    await expect(operator.applyReconciliation(changed.planId, changed.digest, label)).rejects.toMatchObject({ code: 'operator_local_state_changed' });
    await gateway.setPolicy({ ...gateway.policy!.policy, allocationId: randomUUID(), mailboxId: randomUUID() });
    await expect(operator.planReconciliation(address, gatewayId, workerVersion, label)).rejects.toMatchObject({ code: 'operator_remote_binding_mismatch' });
    expect(gateway.reconciliations).toHaveLength(0);
  });

  it('does not overwrite a remote change after planning or between reinspection and CAS', async () => {
    await dynamic();
    const early = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    await gateway.setPolicy({ ...gateway.policy!.policy, operationId: randomUUID(), revision: 2, previousRevision: 1 });
    await expect(operator.applyReconciliation(early.planId, early.digest, label)).rejects.toMatchObject({ code: 'operator_remote_state_changed' });
    const raced = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    const winner = { ...gateway.policy!.policy, operationId: randomUUID(), revision: 3, previousRevision: 2 };
    gateway.beforeReconcile = async () => { await gateway.setPolicy(winner); };
    await expect(operator.applyReconciliation(raced.planId, raced.digest, label)).rejects.toThrow('policy_precondition_failed');
    expect(gateway.policy!.policy).toEqual(winner);
    expect((await pool.query('SELECT count(*) FROM address_policy_history WHERE operation_id = $1', [raced.policy.operationId])).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) FROM address_policy_outbox WHERE operation_id = $1', [raced.policy.operationId])).rows[0].count).toBe('0');
    expect((await pool.query('SELECT status FROM address_operator_plans WHERE id = $1', [raced.planId])).rows[0].status).toBe('failed');
    await legacyUntouched();
  });

  it('reserves a revision without admission evidence before ACK and preserves history after a newer local pause', async () => {
    await dynamic();
    const plan = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    gateway.beforeReconcile = async () => {
      expect((await pool.query('SELECT policy_revision FROM address_registry WHERE address = $1', [address])).rows[0].policy_revision).toBe(String(plan.policy.revision));
      expect((await pool.query('SELECT count(*) FROM address_policy_history WHERE operation_id = $1', [plan.policy.operationId])).rows[0].count).toBe('0');
      expect((await pool.query('SELECT published_operation_id,reserved_at FROM address_operator_plans WHERE id = $1', [plan.planId])).rows[0].published_operation_id).toBeNull();
      // Model a subsequent authoritative restriction while the request is in flight.
      await pool.query("INSERT INTO address_holds(allocation_id,kind,active) VALUES ($1,'system',true)", [allocationId]);
      await pool.query('UPDATE address_allocations SET send_generation = send_generation + 1 WHERE id = $1', [allocationId]);
      await pool.query('UPDATE address_registry SET policy_revision = policy_revision + 1 WHERE address = $1', [address]);
    };
    expect((await operator.applyReconciliation(plan.planId, plan.digest, label)).status).toBe('superseded');
    expect((await pool.query('SELECT count(*) FROM address_policy_history WHERE operation_id = $1', [plan.policy.operationId])).rows[0].count).toBe('1');
    expect((await pool.query('SELECT status FROM address_policy_outbox WHERE operation_id = $1', [plan.policy.operationId])).rows[0].status).toBe('superseded');
  });

  it('recovers lost-ACK evidence after a newer local pause without republishing the old enable policy', async () => {
    await dynamic();
    const plan = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    gateway.loseReconcileResponse = true;
    await expect(operator.applyReconciliation(plan.planId, plan.digest, label)).rejects.toThrow('lost_response');
    await pool.query("INSERT INTO address_holds(allocation_id,kind,active) VALUES ($1,'system',true)", [allocationId]);
    await pool.query('UPDATE address_allocations SET send_generation = send_generation + 1 WHERE id = $1', [allocationId]);
    await pool.query('UPDATE address_registry SET policy_revision = policy_revision + 1 WHERE address = $1', [address]);
    expect((await operator.applyReconciliation(plan.planId, plan.digest, label)).status).toBe('superseded');
    expect(gateway.reconciliations).toHaveLength(1);
    expect((await pool.query('SELECT count(*) FROM address_policy_history WHERE operation_id = $1', [plan.policy.operationId])).rows[0].count).toBe('1');
  });

  it('recovers a lost successful reconciliation response from a fresh exact inspection without resending', async () => {
    await dynamic();
    const plan = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    gateway.loseReconcileResponse = true;
    await expect(operator.applyReconciliation(plan.planId, plan.digest, label)).rejects.toThrow('lost_response');
    expect((await pool.query('SELECT count(*) FROM address_policy_history WHERE operation_id = $1', [plan.policy.operationId])).rows[0].count).toBe('0');
    gateway.loseReconcileResponse = false;
    expect((await operator.applyReconciliation(plan.planId, plan.digest, label)).status).toBe('applied');
    expect(gateway.reconciliations).toHaveLength(1);
    expect((await pool.query('SELECT count(*) FROM address_policy_history WHERE operation_id = $1', [plan.policy.operationId])).rows[0].count).toBe('1');
  });
  it('recovers expired lost-ACK history after a newer remote revision using only the read-only operation lookup', async () => {
    await dynamic();
    const plan = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    gateway.loseReconcileResponse = true;
    await expect(operator.applyReconciliation(plan.planId, plan.digest, label)).rejects.toThrow('lost_response');
    const before = (await pool.query('SELECT policy_revision,current_allocation_id FROM address_registry WHERE address = $1', [address])).rows[0];
    clock = plan.expiresAt + 1;
    await gateway.setPolicy({ ...plan.policy, operationId: randomUUID(), previousRevision: plan.policy.revision, revision: plan.policy.revision + 1, receiveEnabled: false });
    const remote = structuredClone(gateway.policy);
    const result = await operator.recoverReconciliation(plan.planId, plan.digest, label);
    expect(result.status).toBe('recovered');
    expect(gateway.operationReads).toEqual([plan.policy.operationId]);
    expect(gateway.stages).toHaveLength(1); expect(gateway.reconciliations).toHaveLength(1);
    expect(gateway.policy).toEqual(remote);
    expect((await pool.query('SELECT policy_revision,current_allocation_id FROM address_registry WHERE address = $1', [address])).rows[0]).toEqual(before);
    expect((await pool.query('SELECT status FROM address_policy_outbox WHERE operation_id = $1', [plan.policy.operationId])).rows[0].status).toBe('superseded');
    expect((await pool.query('SELECT recovery_evidence FROM address_operator_plans WHERE id = $1', [plan.planId])).rows[0].recovery_evidence.record.policy).toEqual(plan.policy);
    await expect(operator.applyReconciliation(plan.planId, plan.digest, label)).rejects.toMatchObject({ code: 'operator_plan_already_finished' });
    await legacyUntouched();
  });

  it('does not invent history for missing or mismatched remote operation records', async () => {
    await dynamic();
    const plan = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    gateway.loseReconcileResponse = true;
    await expect(operator.applyReconciliation(plan.planId, plan.digest, label)).rejects.toThrow('lost_response');
    const correct = structuredClone(gateway.records.get(plan.policy.operationId)!);
    gateway.records.delete(plan.policy.operationId);
    await expect(operator.recoverReconciliation(plan.planId, plan.digest, label)).rejects.toMatchObject({ code: 'operator_remote_operation_not_found' });
    gateway.records.set(plan.policy.operationId, { ...correct, sha256: '0'.repeat(64) });
    await expect(operator.recoverReconciliation(plan.planId, plan.digest, label)).rejects.toMatchObject({ code: 'operator_policy_confirmation_mismatch' });
    expect((await pool.query('SELECT count(*) FROM address_policy_history WHERE operation_id = $1', [plan.policy.operationId])).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) FROM address_policy_outbox WHERE operation_id = $1', [plan.policy.operationId])).rows[0].count).toBe('0');
  });

  it('recovers authenticated applied evidence after local finalization failed, without activating its current revision', async () => {
    await dynamic();
    const plan = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    await pool.query("ALTER TABLE address_operator_plans ADD CONSTRAINT test_finalize_failure CHECK (status <> 'applied')");
    try { await expect(operator.applyReconciliation(plan.planId, plan.digest, label)).rejects.toThrow(); }
    finally { await pool.query('ALTER TABLE address_operator_plans DROP CONSTRAINT test_finalize_failure'); }
    expect((await pool.query('SELECT count(*) FROM address_policy_history WHERE operation_id = $1', [plan.policy.operationId])).rows[0].count).toBe('0');
    clock = plan.expiresAt + 1;
    expect((await operator.recoverReconciliation(plan.planId, plan.digest, label)).status).toBe('recovered');
    expect((await pool.query('SELECT status FROM address_policy_outbox WHERE operation_id = $1', [plan.policy.operationId])).rows[0].status).toBe('superseded');
    expect(gateway.reconciliations).toHaveLength(1);
  });

  it('does not downgrade already applied history when recording a read-only recovery observation', async () => {
    await dynamic();
    const plan = await operator.planReconciliation(address, gatewayId, workerVersion, label);
    await operator.applyReconciliation(plan.planId, plan.digest, label);
    clock = plan.expiresAt + 1;
    expect((await operator.recoverReconciliation(plan.planId, plan.digest, label)).status).toBe('applied');
    expect((await pool.query('SELECT status FROM address_policy_outbox WHERE operation_id = $1', [plan.policy.operationId])).rows[0].status).toBe('applied');
    await expect(pool.query("UPDATE address_operator_plans SET recovery_evidence = '{}' WHERE id = $1", [plan.planId])).rejects.toThrow('immutable');
  });

});
