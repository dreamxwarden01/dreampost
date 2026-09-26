import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashRoutePolicy, matchesPolicyAck, type RoutePolicy } from '@dreampost/protocol';
import { ApiError } from '../errors.js';
import type { AddressActor, AddressConfig, AddressRequestRow, AddressView, AllocationRow, PersonalMailbox, ResolvePrincipal, SenderEligibility } from './types.js';

export const DEFAULT_RESERVED_LOCAL_PARTS = [
  'info', 'marketing', 'sales', 'support', 'abuse', 'noc', 'security', 'postmaster', 'hostmaster',
  'usenet', 'news', 'webmaster', 'www', 'uucp', 'ftp', 'admin', 'administrator', 'root',
  'noreply', 'no-reply', 'billing', 'mailer-daemon', 'dmarc', 'bounce', 'hr', 'payroll',
] as const;
const reserved = new Set<string>(DEFAULT_RESERVED_LOCAL_PARTS);
const automaticLocalPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const localPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

export function requireUuid(value: string): string {
  if (!uuid.test(value)) throw new ApiError(400, 'invalid_identifier');
  return value.toLowerCase();
}
export function normalizeHostedAddress(value: string, managedDomains: readonly string[], allowReserved = false, supplementalReserved: readonly string[] = []): string {
  const address = value.toLowerCase();
  const parts = address.split('@');
  const [local, domain] = parts;
  if (parts.length !== 2 || !local || local.includes('*') || local.length > 64 || !localPattern.test(local) || !domain || !domainPattern.test(domain) || address.length > 254) {
    throw new ApiError(400, 'invalid_address');
  }
  if (!managedDomains.includes(domain)) throw new ApiError(403, 'unmanaged_address_domain');
  if (!allowReserved && (reserved.has(local) || supplementalReserved.includes(local))) throw new ApiError(409, 'reserved_address');
  return address;
}
function permission(actor: AddressActor, name: string): void {
  if (!actor.permissions.has(name)) throw new ApiError(403, 'permission_denied');
}
function reason(value = ''): string {
  if (typeof value !== 'string' || value.length > 500) throw new ApiError(400, 'invalid_reason');
  return value.trim();
}
function revision(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number >= Number.MAX_SAFE_INTEGER) throw new ApiError(503, 'policy_revision_exhausted');
  return number;
}

export class AddressService {
  readonly config: AddressConfig;
  constructor(readonly pool: Pool, config: AddressConfig, readonly resolvePrincipal: ResolvePrincipal) {
    const managedDomains = [...new Set(config.managedDomains.map((domain) => domain.toLowerCase()))];
    const defaultDomain = config.defaultDomain.toLowerCase();
    if (!managedDomains.length || managedDomains.some((domain) => !domainPattern.test(domain)) || !managedDomains.includes(defaultDomain)) {
      throw new Error('Address configuration requires valid managed domains including the default domain.');
    }
    const reservedLocalParts = [...new Set((config.reservedLocalParts ?? []).map((name) => name.toLowerCase()))];
    if (reservedLocalParts.some((name) => name.length > 64 || name.includes('*') || !localPattern.test(name))) {
      throw new Error('Supplemental reserved names must be valid exact local parts.');
    }
    this.config = { defaultDomain, managedDomains, reservedLocalParts };
  }

  private async mailbox(client: PoolClient, id: string, lock = false): Promise<PersonalMailbox> {
    const { rows } = await client.query<PersonalMailbox>(`SELECT * FROM mailboxes WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [requireUuid(id)]);
    if (!rows[0]) throw new ApiError(404, 'mailbox_not_found');
    return rows[0];
  }
  private async transaction<T>(actorId: string, mailboxId: string | undefined, extraPrincipals: string[], work: (client: PoolClient, actor: AddressActor, mailbox?: PersonalMailbox) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const initialMailbox = mailboxId ? await this.mailbox(client, mailboxId) : undefined;
      const ids = [...new Set([requireUuid(actorId), ...(initialMailbox?.owner_principal_id ? [initialMailbox.owner_principal_id] : []), ...extraPrincipals.map(requireUuid)])].sort();
      await client.query('SELECT id FROM principals WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
      const actor = await this.resolvePrincipal(actorId, client);
      const mailbox = mailboxId ? await this.mailbox(client, mailboxId, true) : undefined;
      if (mailbox && mailbox.owner_principal_id !== initialMailbox?.owner_principal_id) throw new ApiError(409, 'mailbox_owner_changed');
      const result = await work(client, actor, mailbox);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  private async audit(client: PoolClient, actorId: string, allocationId: string | null, action: string, details: Record<string, unknown> = {}): Promise<void> {
    await client.query('INSERT INTO address_audit_events(id, actor_id, allocation_id, action, details) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), actorId, allocationId, action, details]);
  }
  private async requireDynamicRoute(client: PoolClient, address: string): Promise<void> {
    const legacy = await client.query('SELECT 1 FROM recipient_routes WHERE lower(address) = $1 FOR SHARE', [address]);
    if (legacy.rowCount) throw new ApiError(409, 'legacy_route_cutover_required');
  }
  private async activeAllocation(client: PoolClient, allocationId: string): Promise<AllocationRow> {
    const { rows } = await client.query<AllocationRow>(
      `SELECT a.* FROM address_allocations a JOIN address_registry r ON r.current_allocation_id = a.id
       WHERE a.id = $1 AND a.ended_at IS NULL FOR UPDATE OF r, a`, [requireUuid(allocationId)],
    );
    if (!rows[0]) throw new ApiError(409, 'allocation_not_current');
    normalizeHostedAddress(rows[0].address, this.config.managedDomains, true);
    await this.requireDynamicRoute(client, rows[0].address);
    return rows[0];
  }
  private async allocationMailboxId(allocationId: string): Promise<string> {
    const { rows } = await this.pool.query<{ mailbox_id: string }>('SELECT mailbox_id FROM address_allocations WHERE id = $1', [requireUuid(allocationId)]);
    if (!rows[0]) throw new ApiError(404, 'allocation_not_found');
    return rows[0].mailbox_id;
  }
  private ownPersonalMailbox(actor: AddressActor, mailbox: PersonalMailbox): void {
    permission(actor, 'mailbox.use');
    if (mailbox.mailbox_type !== 'personal' || mailbox.owner_principal_id !== actor.principalId || !mailbox.enabled) throw new ApiError(403, 'mailbox_not_owned');
  }
  private async requireMember(client: PoolClient, principalId: string, mailboxId: string, required: string): Promise<void> {
    const { rowCount } = await client.query(
      'SELECT 1 FROM mailbox_memberships WHERE principal_id = $1 AND mailbox_id = $2 AND revoked_at IS NULL AND $3 = ANY(permissions) FOR UPDATE',
      [principalId, mailboxId, required],
    );
    if (!rowCount) throw new ApiError(403, 'mailbox_grant_required');
  }
  private async enqueuePolicy(client: PoolClient, allocation: AllocationRow, enabled?: boolean): Promise<RoutePolicy> {
    const { rows } = await client.query<{ policy_revision: string; current_allocation_id: string | null }>('SELECT policy_revision, current_allocation_id FROM address_registry WHERE address = $1 FOR UPDATE', [allocation.address]);
    const current = rows[0]!;
    const held = await client.query('SELECT 1 FROM address_holds WHERE allocation_id = $1 AND active', [allocation.id]);
    const receiveEnabled = enabled ?? (current.current_allocation_id === allocation.id && allocation.ended_at === null && !held.rowCount);
    const previousRevision = revision(current.policy_revision);
    const policy: RoutePolicy = { version: 1, operationId: randomUUID(), address: allocation.address, allocationId: allocation.id, mailboxId: allocation.mailbox_id, previousRevision, revision: previousRevision + 1, receiveEnabled };
    const sha256 = await hashRoutePolicy(policy);
    await client.query(
      `INSERT INTO address_policy_history(operation_id,address,allocation_id,mailbox_id,previous_revision,revision,receive_enabled,sha256,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [policy.operationId, policy.address, policy.allocationId, policy.mailboxId, previousRevision, policy.revision, receiveEnabled, sha256, policy],
    );
    await client.query('INSERT INTO address_policy_outbox(operation_id) VALUES ($1)', [policy.operationId]);
    await client.query('UPDATE address_registry SET policy_revision = $2 WHERE address = $1', [allocation.address, policy.revision]);
    // Full snapshots supersede unsent or in-flight older work, but retain its admission history.
    await client.query(`UPDATE address_policy_outbox o SET status = 'superseded', superseded_at = COALESCE(superseded_at,now()),
      lease_id = NULL, lease_until = NULL, last_error_code = NULL FROM address_policy_history h
      WHERE h.operation_id = o.operation_id AND h.address = $1 AND h.revision < $2
        AND o.status IN ('pending','inflight','blocked')`, [allocation.address, policy.revision]);
    return policy;
  }
  private async createGrant(client: PoolClient, allocationId: string, principalId: string, actorId: string): Promise<void> {
    await client.query(
      `INSERT INTO address_send_grants(id,allocation_id,principal_id,granted_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (allocation_id,principal_id) WHERE revoked_at IS NULL DO NOTHING`,
      [randomUUID(), allocationId, principalId, actorId],
    );
  }
  private async allocate(client: PoolClient, actor: AddressActor, mailbox: PersonalMailbox, address: string, source: 'first_login' | 'approved' | 'manual' | 'reactivated' | 'reassigned'): Promise<AllocationRow> {
    if (!mailbox.enabled) throw new ApiError(409, 'mailbox_disabled');
    if (mailbox.owner_principal_id) {
      permission(await this.resolvePrincipal(mailbox.owner_principal_id, client), 'mailbox.use');
      await this.requireMember(client, mailbox.owner_principal_id, mailbox.id, 'send_as');
    }
    await this.requireDynamicRoute(client, address);
    const inserted = await client.query('INSERT INTO address_registry(address,domain,state) VALUES ($1,$2,\'retired\') ON CONFLICT DO NOTHING RETURNING address', [address, address.split('@')[1]]);
    const { rows } = await client.query<{ current_allocation_id: string | null }>('SELECT current_allocation_id FROM address_registry WHERE address = $1 FOR UPDATE', [address]);
    const current = rows[0]!.current_allocation_id;
    if (source === 'reactivated') {
      if (current) throw new ApiError(409, 'address_unavailable');
      const prior = await client.query('SELECT 1 FROM address_allocations WHERE address = $1 AND mailbox_id = $2 AND ended_at IS NOT NULL', [address, mailbox.id]);
      if (!prior.rowCount) throw new ApiError(409, 'no_previous_mailbox_allocation');
    } else if (source === 'reassigned') {
      if (inserted.rowCount) throw new ApiError(409, 'no_previous_address_allocation');
      if (current) {
        const old = await this.activeAllocation(client, current);
        if (old.mailbox_id === mailbox.id) throw new ApiError(409, 'address_already_owned');
        await this.endAllocation(client, old);
      }
    } else if (!inserted.rowCount) {
      throw new ApiError(409, current ? 'address_unavailable' : 'address_requires_reactivation');
    }
    const { rows: allocations } = await client.query<AllocationRow>(
      'INSERT INTO address_allocations(id,address,mailbox_id,source,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [randomUUID(), address, mailbox.id, source, actor.principalId],
    );
    const allocation = allocations[0]!;
    await client.query('UPDATE address_registry SET state = \'allocated\', current_allocation_id = $2 WHERE address = $1', [address, allocation.id]);
    if (mailbox.owner_principal_id) await this.createGrant(client, allocation.id, mailbox.owner_principal_id, actor.principalId);
    await this.enqueuePolicy(client, allocation);
    await client.query(`UPDATE mailboxes SET address = CASE WHEN address = '' THEN $2 ELSE address END,
      provisioning_status = CASE WHEN provisioning_status = 'needs_address' THEN 'pending_activation' ELSE provisioning_status END,
      provisioning_code = NULL WHERE id = $1`, [mailbox.id, address]);
    await this.audit(client, actor.principalId, allocation.id, `address.${source}`);
    return allocation;
  }
  private async endAllocation(client: PoolClient, allocation: AllocationRow): Promise<void> {
    await client.query('UPDATE address_allocations SET ended_at = now(), send_generation = send_generation + 1 WHERE id = $1 AND ended_at IS NULL', [allocation.id]);
    await client.query('UPDATE address_send_grants SET revoked_at = now() WHERE allocation_id = $1 AND revoked_at IS NULL', [allocation.id]);
    await client.query('UPDATE address_registry SET current_allocation_id = NULL, state = \'retired\' WHERE address = $1', [allocation.address]);
  }

  async provisionFirstMailbox(principalId: string): Promise<PersonalMailbox> {
    return this.transaction(principalId, undefined, [], async (client, actor) => {
      permission(actor, 'mailbox.use');
      const existing = await client.query<PersonalMailbox>('SELECT * FROM mailboxes WHERE owner_principal_id = $1 AND mailbox_type = \'personal\' FOR UPDATE', [principalId]);
      if (existing.rows[0]) return existing.rows[0];
      const { rows } = await client.query<PersonalMailbox>(
        `INSERT INTO mailboxes(id,address,name,mailbox_type,owner_principal_id,provisioning_status)
         VALUES ($1,'',$2,'personal',$3,'needs_address') RETURNING *`, [randomUUID(), 'Personal mailbox', principalId],
      );
      const mailbox = rows[0]!;
      await client.query('INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES ($1,$2,$3)', [mailbox.id, principalId, ['read', 'manage', 'send_as']]);
      try {
        if (!automaticLocalPattern.test(actor.username.toLowerCase())) throw new ApiError(400, 'invalid_automatic_username');
        const address = normalizeHostedAddress(`${actor.username}@${this.config.defaultDomain}`, this.config.managedDomains, false, this.config.reservedLocalParts);
        await this.allocate(client, actor, mailbox, address, 'first_login');
      } catch (error) {
        if (!(error instanceof ApiError) || ![400, 409].includes(error.statusCode)) throw error;
        await client.query('UPDATE mailboxes SET provisioning_code = $2 WHERE id = $1', [mailbox.id, error.code]);
      }
      return this.mailbox(client, mailbox.id);
    });
  }

  async requestAddress(principalId: string, input: { address: string; action?: 'add' | 'reactivate' }): Promise<AddressRequestRow> {
    const personal = await this.provisionFirstMailbox(principalId);
    return this.transaction(principalId, personal.id, [], async (client, actor, mailbox) => {
      this.ownPersonalMailbox(actor, mailbox!);
      const address = normalizeHostedAddress(input.address, this.config.managedDomains, false, this.config.reservedLocalParts);
      const action = input.action ?? 'add';
      if (!['add', 'reactivate'].includes(action)) throw new ApiError(400, 'invalid_request_action');
      const existing = await client.query<AddressRequestRow>('SELECT * FROM address_requests WHERE requester_id = $1 AND address = $2 AND action = $3 AND status = \'pending\'', [principalId, address, action]);
      if (existing.rows[0]) return existing.rows[0];
      const count = await client.query<{ pending: string; recent: string }>(`SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
        count(*) FILTER (WHERE created_at > now() - interval '1 day') AS recent FROM address_requests WHERE requester_id = $1`, [principalId]);
      if (Number(count.rows[0]!.pending) >= 10 || Number(count.rows[0]!.recent) >= 20) throw new ApiError(429, 'address_request_limit');
      const { rows } = await client.query<AddressRequestRow>('INSERT INTO address_requests(id,requester_id,mailbox_id,address,action) VALUES ($1,$2,$3,$4,$5) RETURNING *', [randomUUID(), principalId, mailbox!.id, address, action]);
      await this.audit(client, principalId, null, 'address.requested', { requestId: rows[0]!.id });
      return rows[0]!;
    });
  }
  private async getRequest(id: string): Promise<AddressRequestRow> {
    const { rows } = await this.pool.query<AddressRequestRow>('SELECT * FROM address_requests WHERE id = $1', [requireUuid(id)]);
    if (!rows[0]) throw new ApiError(404, 'address_request_not_found');
    return rows[0];
  }
  async approveRequest(actorId: string, requestId: string): Promise<AllocationRow> {
    const initial = await this.getRequest(requestId);
    return this.transaction(actorId, initial.mailbox_id, [initial.requester_id], async (client, actor, mailbox) => {
      permission(actor, 'addresses.manage');
      const requester = await this.resolvePrincipal(initial.requester_id, client);
      this.ownPersonalMailbox(requester, mailbox!);
      const { rows } = await client.query<AddressRequestRow>('SELECT * FROM address_requests WHERE id = $1 FOR UPDATE', [requestId]);
      const request = rows[0]!;
      if (request.status === 'approved' && request.allocation_id) {
        return (await client.query<AllocationRow>('SELECT * FROM address_allocations WHERE id = $1', [request.allocation_id])).rows[0]!;
      }
      if (request.status !== 'pending') throw new ApiError(409, 'address_request_decided');
      const address = normalizeHostedAddress(request.address, this.config.managedDomains, false, this.config.reservedLocalParts);
      const allocation = await this.allocate(client, actor, mailbox!, address, request.action === 'reactivate' ? 'reactivated' : 'approved');
      await client.query('UPDATE address_requests SET status = \'approved\', allocation_id = $2, decided_by = $3, decided_at = now() WHERE id = $1', [requestId, allocation.id, actorId]);
      return allocation;
    });
  }
  async rejectRequest(actorId: string, requestId: string, decisionReason = ''): Promise<void> {
    const initial = await this.getRequest(requestId);
    await this.transaction(actorId, initial.mailbox_id, [], async (client, actor) => {
      permission(actor, 'addresses.manage');
      normalizeHostedAddress(initial.address, this.config.managedDomains, true);
      const { rows } = await client.query<AddressRequestRow>('SELECT * FROM address_requests WHERE id = $1 FOR UPDATE', [requestId]);
      if (rows[0]!.status === 'rejected') return;
      if (rows[0]!.status !== 'pending') throw new ApiError(409, 'address_request_decided');
      await client.query('UPDATE address_requests SET status = \'rejected\', decision_reason = $2, decided_by = $3, decided_at = now() WHERE id = $1', [requestId, reason(decisionReason), actorId]);
      await this.audit(client, actorId, null, 'address.request_rejected', { requestId });
    });
  }
  async addAddress(actorId: string, input: { address: string; mailboxId: string }, mode: 'manual' | 'reactivated' | 'reassigned' = 'manual'): Promise<AllocationRow> {
    return this.transaction(actorId, input.mailboxId, [], async (client, actor, mailbox) => {
      permission(actor, 'addresses.manage');
      const address = normalizeHostedAddress(input.address, this.config.managedDomains, true);
      return this.allocate(client, actor, mailbox!, address, mode);
    });
  }
  async removeAddress(actorId: string, allocationId: string): Promise<void> {
    await this.transaction(actorId, await this.allocationMailboxId(allocationId), [], async (client, actor) => {
      permission(actor, 'addresses.manage');
      const allocation = await this.activeAllocation(client, allocationId);
      await this.endAllocation(client, allocation);
      await this.enqueuePolicy(client, allocation, false);
      await this.audit(client, actorId, allocation.id, 'address.removed');
    });
  }
  async setPause(actorId: string, allocationId: string, kind: 'owner' | 'admin', paused: boolean, holdReason = ''): Promise<void> {
    if (typeof paused !== 'boolean' || !['owner', 'admin'].includes(kind)) throw new ApiError(400, 'invalid_pause');
    await this.transaction(actorId, await this.allocationMailboxId(allocationId), [], async (client, actor, mailbox) => {
      if (kind === 'owner') this.ownPersonalMailbox(actor, mailbox!);
      else permission(actor, 'addresses.manage');
      const allocation = await this.activeAllocation(client, allocationId);
      const old = await client.query<{ active: boolean }>('SELECT active FROM address_holds WHERE allocation_id = $1 AND kind = $2', [allocationId, kind]);
      if ((old.rows[0]?.active ?? false) === paused) return;
      await client.query(`INSERT INTO address_holds(allocation_id,kind,active,changed_by,reason) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (allocation_id,kind) DO UPDATE SET active = EXCLUDED.active, changed_by = EXCLUDED.changed_by, reason = EXCLUDED.reason, updated_at = now()`, [allocationId, kind, paused, actorId, reason(holdReason)]);
      await client.query('UPDATE address_allocations SET send_generation = send_generation + 1 WHERE id = $1', [allocationId]);
      await this.enqueuePolicy(client, allocation);
      await this.audit(client, actorId, allocationId, `address.${kind}_${paused ? 'paused' : 'resumed'}`);
    });
  }
  async setReceiveOnly(actorId: string, allocationId: string, receiveOnly: boolean): Promise<void> {
    if (typeof receiveOnly !== 'boolean') throw new ApiError(400, 'invalid_receive_only');
    await this.transaction(actorId, await this.allocationMailboxId(allocationId), [], async (client, actor) => {
      permission(actor, 'addresses.manage');
      const allocation = await this.activeAllocation(client, allocationId);
      if (allocation.receive_only === receiveOnly) return;
      await client.query('UPDATE address_allocations SET receive_only = $2, send_generation = send_generation + 1 WHERE id = $1', [allocationId, receiveOnly]);
      await this.enqueuePolicy(client, allocation);
      await this.audit(client, actorId, allocationId, 'address.receive_only_changed', { receiveOnly });
    });
  }
  async setSendGrant(actorId: string, allocationId: string, principalId: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new ApiError(400, 'invalid_send_grant');
    await this.transaction(actorId, await this.allocationMailboxId(allocationId), [principalId], async (client, actor) => {
      permission(actor, 'addresses.manage');
      const allocation = await this.activeAllocation(client, allocationId);
      if (enabled) {
        permission(await this.resolvePrincipal(principalId, client), 'mailbox.use');
        await this.requireMember(client, principalId, allocation.mailbox_id, 'send_as');
        await this.createGrant(client, allocationId, principalId, actorId);
      } else {
        await client.query('UPDATE address_send_grants SET revoked_at = now() WHERE allocation_id = $1 AND principal_id = $2 AND revoked_at IS NULL', [allocationId, principalId]);
      }
      await client.query('UPDATE address_allocations SET send_generation = send_generation + 1 WHERE id = $1', [allocationId]);
      await this.audit(client, actorId, allocationId, enabled ? 'address.send_granted' : 'address.send_revoked', { principalId });
    });
  }

  async acknowledgePolicy(value: unknown): Promise<void> {
    const input = value as { operationId?: unknown } | null;
    if (!input || typeof input.operationId !== 'string') throw new ApiError(400, 'invalid_policy_ack');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ payload: RoutePolicy; sha256: string }>('SELECT payload, sha256 FROM address_policy_history WHERE operation_id = $1', [requireUuid(input.operationId)]);
      const record = rows[0];
      if (!record || !matchesPolicyAck(value, { ...record.payload, sha256: record.sha256 })) throw new ApiError(409, 'policy_ack_mismatch');
      // Keep the mailbox-before-registry order used by lifecycle mutations.
      await client.query('SELECT id FROM mailboxes WHERE id = $1 FOR UPDATE', [record.payload.mailboxId]);
      await client.query('SELECT address FROM address_registry WHERE address = $1 FOR UPDATE', [record.payload.address]);
      await client.query(`UPDATE address_policy_outbox SET
        status = CASE WHEN status = 'applied' OR EXISTS (
          SELECT 1 FROM address_registry WHERE address = $2 AND policy_revision = $3
        ) THEN 'applied' ELSE 'superseded' END,
        applied_at = COALESCE(applied_at, now()), lease_until = NULL, lease_id = NULL, last_error_code = NULL
        WHERE operation_id = $1`, [record.payload.operationId, record.payload.address, record.payload.revision]);
      if (record.payload.receiveEnabled) {
        await client.query(`UPDATE mailboxes SET provisioning_status = 'ready', provisioning_code = NULL
          WHERE id = $1 AND provisioning_status = 'pending_activation'
          AND EXISTS (SELECT 1 FROM address_registry WHERE address = $2 AND current_allocation_id = $3 AND policy_revision = $4)
          AND NOT EXISTS (SELECT 1 FROM address_holds WHERE allocation_id = $3 AND active)`,
        [record.payload.mailboxId, record.payload.address, record.payload.allocationId, record.payload.revision]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async view(client: PoolClient, allocationId: string): Promise<AddressView> {
    const { rows } = await client.query<AllocationRow & { current_allocation_id: string | null; policy_revision: string; acknowledged: boolean; receive_enabled: boolean | null; owner_hold: boolean; admin_hold: boolean; system_hold: boolean; policy_status: string; policy_error: string | null }>(
      `SELECT a.*, r.current_allocation_id, r.policy_revision, COALESCE(o.status = 'applied',false) AS acknowledged, h.receive_enabled, COALESCE(o.status,'unpublished') AS policy_status, o.last_error_code AS policy_error,
       EXISTS(SELECT 1 FROM address_holds WHERE allocation_id = a.id AND kind = 'owner' AND active) AS owner_hold,
       EXISTS(SELECT 1 FROM address_holds WHERE allocation_id = a.id AND kind = 'admin' AND active) AS admin_hold,
       EXISTS(SELECT 1 FROM address_holds WHERE allocation_id = a.id AND kind = 'system' AND active) AS system_hold
       FROM address_allocations a JOIN address_registry r ON r.address = a.address
       LEFT JOIN address_policy_history h ON h.address = r.address AND h.revision = r.policy_revision AND h.allocation_id = a.id
       LEFT JOIN address_policy_outbox o ON o.operation_id = h.operation_id
       WHERE a.id = $1`, [allocationId],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, 'allocation_not_found');
    return { allocationId: row.id, address: row.address, mailboxId: row.mailbox_id, current: row.current_allocation_id === row.id && row.ended_at === null,
      receiveOnly: row.receive_only, ownerPaused: row.owner_hold, adminPaused: row.admin_hold, systemPaused: row.system_hold,
      receiveEnabled: row.current_allocation_id === row.id && row.ended_at === null && row.receive_enabled === true && row.acknowledged, policyRevision: Number(row.policy_revision), policyAcknowledged: row.acknowledged, policyStatus: row.policy_status, policyError: row.policy_error,
      sendingGeneration: Number(row.send_generation) };
  }
  private async eligibility(client: PoolClient, actor: AddressActor, allocationId: string): Promise<SenderEligibility> {
    const view = await this.view(client, allocationId);
    const result: SenderEligibility = { eligible: false, reason: null, allocationId, mailboxId: view.mailboxId, address: view.address, sendingGeneration: view.sendingGeneration, policyRevision: view.policyRevision };
    const deny = (why: string): SenderEligibility => ({ ...result, reason: why });
    if (!actor.permissions.has('mailbox.use')) return deny('mailbox_access_denied');
    if (!view.current) return deny('allocation_ended');
    if (view.ownerPaused || view.adminPaused || view.systemPaused) return deny('address_paused');
    if (view.receiveOnly) return deny('receive_only');
    if (!view.policyAcknowledged || !view.receiveEnabled) return deny('receiving_activation_pending');
    const mailbox = await this.mailbox(client, view.mailboxId);
    if (!mailbox.enabled) return deny('mailbox_disabled');
    const membership = await client.query('SELECT 1 FROM mailbox_memberships WHERE mailbox_id = $1 AND principal_id = $2 AND revoked_at IS NULL AND \'send_as\' = ANY(permissions)', [view.mailboxId, actor.principalId]);
    if (!membership.rowCount) return deny('mailbox_grant_required');
    const grant = await client.query<{ id: string }>('SELECT id FROM address_send_grants WHERE allocation_id = $1 AND principal_id = $2 AND revoked_at IS NULL', [allocationId, actor.principalId]);
    if (!grant.rows[0]) return deny('send_grant_required');
    const policy = await client.query<{ sha256: string }>('SELECT sha256 FROM address_policy_history WHERE address = $1 AND revision = $2 AND allocation_id = $3 AND receive_enabled', [view.address, view.policyRevision, allocationId]);
    return { ...result, eligible: true, grantId: grant.rows[0].id, policyDigest: policy.rows[0]!.sha256 };
  }
  /** A current-state resolver, not a dispatch permit. No sending transport exists in this slice. */
  async resolveSenderEligibility(principalId: string, allocationId: string): Promise<SenderEligibility> {
    return this.transaction(principalId, await this.allocationMailboxId(allocationId), [], async (client, actor) => {
      await client.query('SELECT address FROM address_registry WHERE address = (SELECT address FROM address_allocations WHERE id = $1) FOR UPDATE', [allocationId]);
      return this.eligibility(client, actor, allocationId);
    });
  }
  async listForActor(principalId: string): Promise<{ mailbox: PersonalMailbox | null; addresses: AddressView[]; requests: AddressRequestRow[] }> {
    return this.transaction(principalId, undefined, [], async (client, actor) => {
      permission(actor, 'mailbox.use');
      const mailbox = (await client.query<PersonalMailbox>('SELECT * FROM mailboxes WHERE owner_principal_id = $1 AND mailbox_type = \'personal\'', [principalId])).rows[0] ?? null;
      const ids = mailbox ? (await client.query<{ id: string }>('SELECT id FROM address_allocations WHERE mailbox_id = $1 ORDER BY created_at DESC', [mailbox.id])).rows : [];
      const addresses: AddressView[] = [];
      for (const row of ids) addresses.push(await this.view(client, row.id));
      if (mailbox && mailbox.provisioning_status === 'pending_activation' && addresses.some((item) => item.current && item.policyAcknowledged && item.receiveEnabled)) mailbox.provisioning_status = 'ready';
      const { rows: requests } = await client.query<AddressRequestRow>('SELECT * FROM address_requests WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 100', [principalId]);
      return { mailbox, addresses, requests };
    });
  }
  async listRequests(actorId: string): Promise<AddressRequestRow[]> {
    return this.transaction(actorId, undefined, [], async (client, actor) => {
      permission(actor, 'addresses.manage');
      return (await client.query<AddressRequestRow>(`SELECT * FROM address_requests WHERE status = 'pending' AND split_part(address,'@',2) = ANY($1::text[]) ORDER BY created_at LIMIT 100`, [this.config.managedDomains])).rows;
    });
  }
  async listAdminAddresses(actorId: string): Promise<Array<AddressView & { mailboxName: string; ownerUsername: string | null }>> {
    return this.transaction(actorId, undefined, [], async (client, actor) => {
      permission(actor, 'addresses.manage');
      const { rows } = await client.query<{ id: string; name: string; username: string | null }>(
        `SELECT a.id, m.name, p.username FROM address_allocations a JOIN mailboxes m ON m.id = a.mailbox_id
         LEFT JOIN principals p ON p.id = m.owner_principal_id JOIN address_registry r ON r.address = a.address
         WHERE r.domain = ANY($1::text[]) ORDER BY a.created_at DESC LIMIT 200`, [this.config.managedDomains]);
      const addresses: Array<AddressView & { mailboxName: string; ownerUsername: string | null }> = [];
      for (const row of rows) addresses.push({ ...await this.view(client, row.id), mailboxName: row.name, ownerUsername: row.username });
      return addresses;
    });
  }
  async listAdminMailboxes(actorId: string): Promise<Array<{ id: string; name: string; ownerUsername: string | null; mailboxType: string }>> {
    return this.transaction(actorId, undefined, [], async (client, actor) => {
      permission(actor, 'addresses.manage');
      const { rows } = await client.query<{ id: string; name: string; username: string | null; mailbox_type: string }>(
        `SELECT m.id,m.name,p.username,m.mailbox_type FROM mailboxes m LEFT JOIN principals p ON p.id = m.owner_principal_id
         WHERE m.enabled ORDER BY m.created_at LIMIT 200`);
      return rows.map((row) => ({ id: row.id, name: row.name, ownerUsername: row.username, mailboxType: row.mailbox_type }));
    });
  }
  async listSendingIdentities(principalId: string): Promise<SenderEligibility[]> {
    return this.transaction(principalId, undefined, [], async (client, actor) => {
      permission(actor, 'mailbox.use');
      const { rows } = await client.query<{ id: string }>(`SELECT a.id FROM address_allocations a JOIN mailbox_memberships m ON m.mailbox_id = a.mailbox_id
        WHERE m.principal_id = $1 AND m.revoked_at IS NULL AND a.ended_at IS NULL ORDER BY a.address`, [principalId]);
      const identities: SenderEligibility[] = [];
      for (const row of rows) identities.push(await this.eligibility(client, actor, row.id));
      return identities;
    });
  }
}
