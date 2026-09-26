import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashRoutePolicy, type RoutePolicy } from '@dreampost/protocol';
import { migrate, seedMailbox } from '../src/database.js';
import { ApiError } from '../src/errors.js';
import { AddressService, dispatchOnePolicy, normalizeHostedAddress, type AddressActor } from '../src/addresses/index.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const alice = randomUUID(), bob = randomUUID(), adminId = randomUUID();
const issuer = 'https://sso.example.test';
const config = { defaultDomain: 'example.test', managedDomains: ['example.test'] };
const key = { id: 'policy-test', secret: 'test-policy-secret-at-least-32-bytes' };

it('normalizes exact managed addresses while rejecting unsafe and reserved automatic candidates', () => {
  expect(normalizeHostedAddress('A.Reader+tag@EXAMPLE.TEST', config.managedDomains)).toBe('a.reader+tag@example.test');
  for (const address of ['a..b@example.test', '.bad@example.test', '*@example.test', 'name @example.test', 'root@example.test', 'a@other.test']) {
    expect(() => normalizeHostedAddress(address, config.managedDomains)).toThrow();
  }
  expect(normalizeHostedAddress('postmaster@example.test', config.managedDomains, true)).toBe('postmaster@example.test');
});

describe.skipIf(!databaseUrl)('address lifecycle with isolated PostgreSQL', () => {
  const schema = `addresses_test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let service: AddressService;
  const resolve = async (id: string, client?: PoolClient): Promise<AddressActor> => {
    const db = client ?? pool;
    const row = (await db.query(`SELECT * FROM principals WHERE id = $1${client ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!row?.access_enabled || row.app_role === null) throw new ApiError(403, 'application_access_denied');
    const permissions = new Set<string>((await db.query('SELECT permission FROM auth_role_permissions WHERE role_id = $1', [row.app_role])).rows.map((item) => item.permission));
    for (const override of (await db.query('SELECT permission,effect FROM auth_user_permission_overrides WHERE principal_id = $1', [id])).rows) {
      if (override.effect === 'allow') permissions.add(override.permission); else permissions.delete(override.permission);
    }
    return { principalId: id, issuer, subject: row.subject, username: row.username, roleId: row.app_role, permissions };
  };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
    service = new AddressService(pool, config, resolve);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE mailboxes, principals CASCADE');
    for (const [id, username, role] of [[alice, 'alice', 1], [bob, 'bob', 1], [adminId, 'postmaster', 0]]) {
      await pool.query('INSERT INTO principals(id,issuer,subject,username,app_role,access_enabled) VALUES ($1,$2,$5,$3,$4,true)', [id, issuer, username, role, id]);
    }
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  async function allocation(principal = alice) {
    await service.provisionFirstMailbox(principal);
    return (await service.listForActor(principal)).addresses.find((item) => item.current)!;
  }
  async function latest(address: string): Promise<RoutePolicy> {
    return (await pool.query('SELECT payload FROM address_policy_history WHERE address = $1 ORDER BY revision DESC LIMIT 1', [address])).rows[0].payload;
  }
  async function ack(policy: RoutePolicy) {
    return { version: 1, operationId: policy.operationId, address: policy.address, revision: policy.revision, sha256: await hashRoutePolicy(policy), status: 'applied' };
  }
  async function accept(policy: RoutePolicy) { await service.acknowledgePolicy(await ack(policy)); }

  it('provisions exactly one mailbox/allocation/grant under concurrent first logins', async () => {
    const mailboxes = await Promise.all(Array.from({ length: 8 }, () => service.provisionFirstMailbox(alice)));
    expect(new Set(mailboxes.map((item) => item.id)).size).toBe(1);
    expect((await pool.query('SELECT count(*) FROM address_allocations')).rows[0].count).toBe('1');
    expect((await pool.query('SELECT count(*) FROM address_send_grants')).rows[0].count).toBe('1');
    expect((await pool.query('SELECT count(*) FROM address_policy_outbox')).rows[0].count).toBe('1');
    await pool.query('UPDATE principals SET username = \'new-alice\' WHERE id = $1', [alice]);
    expect((await service.provisionFirstMailbox(alice)).id).toBe(mailboxes[0]!.id);
    expect((await pool.query('SELECT count(*) FROM address_allocations')).rows[0].count).toBe('1');
  });

  it('keeps invalid/reserved/conflicting first candidates in needs-address without claiming legacy mail', async () => {
    await pool.query('UPDATE principals SET username = \'postmaster\' WHERE id = $1', [alice]);
    expect((await service.provisionFirstMailbox(alice)).provisioning_code).toBe('reserved_address');
    await pool.query('UPDATE principals SET username = \'a..b\' WHERE id = $1', [bob]);
    expect((await service.provisionFirstMailbox(bob)).provisioning_code).toBe('invalid_address');
    const legacyId = randomUUID();
    await seedMailbox(pool, { id: legacyId, address: 'postmaster@example.test', name: 'Legacy' });
    const adminMailbox = await service.provisionFirstMailbox(adminId);
    expect(adminMailbox.id).not.toBe(legacyId);
    expect(adminMailbox.provisioning_status).toBe('needs_address');
    expect((await pool.query('SELECT owner_principal_id FROM mailboxes WHERE id = $1', [legacyId])).rows[0].owner_principal_id).toBeNull();
  });

  it('resolves concurrent username collisions without duplicate address claims', async () => {
    await pool.query('UPDATE principals SET username = \'shared\' WHERE id = ANY($1::uuid[])', [[alice, bob]]);
    const mailboxes = await Promise.all([service.provisionFirstMailbox(alice), service.provisionFirstMailbox(bob)]);
    expect(mailboxes.filter((mailbox) => mailbox.provisioning_status === 'needs_address')).toHaveLength(1);
    expect((await pool.query('SELECT count(*) FROM address_allocations WHERE address = \'shared@example.test\'')).rows[0].count).toBe('1');
  });

  it('requires approval for aliases, deduplicates requests, and keeps all aliases in the same mailbox', async () => {
    const first = await allocation();
    const requests = await Promise.all(Array.from({ length: 4 }, () => service.requestAddress(alice, { address: 'alias@example.test' })));
    expect(new Set(requests.map((item) => item.id)).size).toBe(1);
    expect((await service.listForActor(alice)).addresses).toHaveLength(1);
    await expect(service.approveRequest(bob, requests[0]!.id)).rejects.toMatchObject({ statusCode: 403 });
    const approved = await Promise.all([service.approveRequest(adminId, requests[0]!.id), service.approveRequest(adminId, requests[0]!.id)]);
    expect(approved[0]!.id).toBe(approved[1]!.id);
    expect(approved[0]!.mailbox_id).toBe(first.mailboxId);
    expect((await service.listForActor(alice)).addresses).toHaveLength(2);
    expect((await pool.query('SELECT count(*) FROM mailboxes WHERE owner_principal_id = $1', [alice])).rows[0].count).toBe('1');
  });

  it('rechecks allocation availability and target admission during approval', async () => {
    const aliceBox = await service.provisionFirstMailbox(alice);
    const bobBox = await service.provisionFirstMailbox(bob);
    const first = await service.requestAddress(alice, { address: 'conflict@example.test' });
    const second = await service.requestAddress(bob, { address: 'conflict@example.test' });
    const outcomes = await Promise.allSettled([service.approveRequest(adminId, first.id), service.approveRequest(adminId, second.id)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const denied = await service.requestAddress(alice, { address: 'after-revoke@example.test' });
    await pool.query('UPDATE principals SET access_enabled = false WHERE id = $1', [alice]);
    await expect(service.approveRequest(adminId, denied.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(aliceBox.id).not.toBe(bobBox.id);
  });

  it('rejects requests and caps pending request spam without reserving candidate addresses', async () => {
    await allocation();
    const rejected = await service.requestAddress(alice, { address: 'denied@example.test' });
    await service.rejectRequest(adminId, rejected.id, 'Use another address.');
    await expect(service.approveRequest(adminId, rejected.id)).rejects.toMatchObject({ statusCode: 409 });
    for (let i = 0; i < 10; i++) await service.requestAddress(alice, { address: `request${i}@example.test` });
    await expect(service.requestAddress(alice, { address: 'extra@example.test' })).rejects.toMatchObject({ statusCode: 429 });
    expect((await pool.query('SELECT 1 FROM address_registry WHERE address = \'request0@example.test\'')).rowCount).toBe(0);
  });

  it('requires exact current activation ACK and rejects stale enable ACK after a new pause', async () => {
    const first = await allocation();
    const initial = await latest(first.address);
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('receiving_activation_pending');
    await service.setPause(alice, first.allocationId, 'owner', true);
    await accept(initial);
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('address_paused');
    await accept(await latest(first.address));
    await service.setPause(alice, first.allocationId, 'owner', false);
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('receiving_activation_pending');
    await expect(service.acknowledgePolicy({ ...await ack(await latest(first.address)), sha256: '0'.repeat(64) })).rejects.toMatchObject({ statusCode: 409 });
    await accept(await latest(first.address));
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).eligible).toBe(true);
    expect((await service.provisionFirstMailbox(alice)).provisioning_status).toBe('ready');
    await service.setPause(alice, first.allocationId, 'owner', true);
    expect((await service.provisionFirstMailbox(alice)).provisioning_status).toBe('ready');
  });

  it('keeps owner/admin holds independent and receive-only cannot clear a pause or grant', async () => {
    const first = await allocation();
    await accept(await latest(first.address));
    await service.setPause(alice, first.allocationId, 'owner', true);
    await service.setPause(adminId, first.allocationId, 'admin', true);
    await service.setPause(alice, first.allocationId, 'owner', false);
    await accept(await latest(first.address));
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('address_paused');
    await expect(service.setPause(alice, first.allocationId, 'admin', false)).rejects.toMatchObject({ statusCode: 403 });
    await service.setReceiveOnly(adminId, first.allocationId, true);
    await service.setPause(adminId, first.allocationId, 'admin', false);
    await accept(await latest(first.address));
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('receive_only');
    await service.setSendGrant(adminId, first.allocationId, alice, false);
    await service.setReceiveOnly(adminId, first.allocationId, false);
    await accept(await latest(first.address));
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('send_grant_required');
  });

  it('preserves mailbox history across removal/reassignment/restoration with fresh grants and epochs', async () => {
    const first = await allocation();
    const bobBox = await service.provisionFirstMailbox(bob);
    const enabled = await latest(first.address);
    await accept(enabled);
    const grant = await service.resolveSenderEligibility(alice, first.allocationId);
    await service.removeAddress(adminId, first.allocationId);
    await expect(service.addAddress(adminId, { address: first.address, mailboxId: bobBox.id })).rejects.toMatchObject({ code: 'address_requires_reactivation' });
    const reassigned = await service.addAddress(adminId, { address: first.address, mailboxId: bobBox.id }, 'reassigned');
    expect(reassigned.mailbox_id).toBe(bobBox.id);
    await expect(service.addAddress(adminId, { address: first.address, mailboxId: first.mailboxId }, 'reactivated')).rejects.toMatchObject({ statusCode: 409 });
    await service.removeAddress(adminId, reassigned.id);
    const restored = await service.addAddress(adminId, { address: first.address, mailboxId: first.mailboxId }, 'reactivated');
    expect(restored.id).not.toBe(first.allocationId);
    await accept(await latest(first.address));
    const current = await service.resolveSenderEligibility(alice, restored.id);
    expect(current.eligible).toBe(true);
    expect(current.grantId).not.toBe(grant.grantId);
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('allocation_ended');
    const history = (await pool.query('SELECT * FROM address_policy_history WHERE operation_id = $1', [enabled.operationId])).rows[0];
    expect(history.mailbox_id).toBe(first.mailboxId);
    expect(history.receive_enabled).toBe(true);
    expect(history.sha256).toBe(await hashRoutePolicy(enabled));
    await expect(pool.query('UPDATE address_policy_history SET receive_enabled = false WHERE operation_id = $1', [enabled.operationId])).rejects.toThrow('immutable');
    await expect(pool.query('UPDATE address_allocations SET mailbox_id = $2 WHERE id = $1', [first.allocationId, bobBox.id])).rejects.toThrow('immutable');
  });

  it('revalidates live admission, permissions, and membership instead of trusting stale actor data', async () => {
    const first = await allocation();
    await accept(await latest(first.address));
    await pool.query('INSERT INTO auth_user_permission_overrides(principal_id,permission,effect) VALUES ($1,\'addresses.manage\',\'deny\')', [adminId]);
    await expect(service.removeAddress(adminId, first.allocationId)).rejects.toMatchObject({ statusCode: 403 });
    await pool.query('UPDATE mailbox_memberships SET revoked_at = now() WHERE principal_id = $1', [alice]);
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('mailbox_grant_required');
    await pool.query('UPDATE principals SET access_enabled = false WHERE id = $1', [alice]);
    await expect(service.setPause(alice, first.allocationId, 'owner', true)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('limits administrator operations to configured domains and ordinary owner operations to their mailbox', async () => {
    const first = await allocation();
    await service.provisionFirstMailbox(bob);
    await expect(service.setPause(bob, first.allocationId, 'owner', true)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.addAddress(adminId, { address: 'x@external.test', mailboxId: first.mailboxId })).rejects.toMatchObject({ code: 'unmanaged_address_domain' });
    await expect(service.listAdminMailboxes(alice)).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.listAdminAddresses(adminId))[0]?.ownerUsername).toBeTruthy();
  });

  it('serializes mutation against an already-committing admission revocation', async () => {
    const first = await allocation();
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('UPDATE principals SET access_enabled = false WHERE id = $1', [alice]);
    const mutation = service.setPause(alice, first.allocationId, 'owner', true);
    const outcome = expect(mutation).rejects.toMatchObject({ statusCode: 403 });
    await client.query('COMMIT');
    client.release();
    await outcome;
    expect((await pool.query('SELECT 1 FROM address_holds WHERE allocation_id = $1 AND active', [first.allocationId])).rowCount).toBe(0);
  });

  it('dispatches only the latest snapshot and resumes its expired lease with a fresh signature', async () => {
    const first = await allocation();
    const superseded = await latest(first.address);
    await service.setPause(alice, first.allocationId, 'owner', true);
    const initial = await latest(first.address);
    expect((await pool.query('SELECT status FROM address_policy_outbox WHERE operation_id = $1', [superseded.operationId])).rows[0].status).toBe('superseded');
    let firstAttempt: string | null = null;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const policy = JSON.parse(String(init?.body)) as RoutePolicy;
      const attempt = new Headers(init?.headers).get('x-dreampost-policy-attempt-id');
      expect(init?.redirect).toBe('manual');
      if (!firstAttempt) { firstAttempt = attempt; throw new Error('Lost response'); }
      expect(attempt).not.toBe(firstAttempt);
      expect(policy.operationId).toBe(initial.operationId);
      return Response.json(await ack(policy));
    });
    const options = { gatewayUrl: 'https://edge.example.test/internal/v1/recipient-policies', key, fetch: fetcher };
    expect(await dispatchOnePolicy(service, options)).toBe(true);
    expect(await dispatchOnePolicy(service, options)).toBe(false);
    await pool.query("UPDATE address_policy_outbox SET status = 'inflight', lease_until = now() - interval '1 second', lease_id = $2 WHERE operation_id = $1", [initial.operationId, randomUUID()]);
    expect(await dispatchOnePolicy(service, options)).toBe(true);
    expect((await pool.query('SELECT status FROM address_policy_outbox WHERE operation_id = $1', [initial.operationId])).rows[0].status).toBe('applied');
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).eligible).toBe(false);
  });

  it('retries proxy failures, malformed ACKs and authorization failures without advancing the address', async () => {
    const first = await allocation();
    for (const response of [new Response('<html>missing</html>', { status: 404 }), new Response('<html>proxy</html>', { status: 200 }), Response.json({ error: 'invalid_policy_authorization' }, { status: 401 }), new Response(null, { status: 302 }), Response.json({ status: 'applied' })]) {
      await pool.query("UPDATE address_policy_outbox SET available_at = now() WHERE status = 'pending'");
      await dispatchOnePolicy(service, { gatewayUrl: 'https://edge.example.test/internal/v1/recipient-policies', key, fetch: vi.fn<typeof fetch>().mockResolvedValue(response) });
      expect((await pool.query('SELECT status FROM address_policy_outbox')).rows[0].status).toBe('pending');
      expect((await service.resolveSenderEligibility(alice, first.allocationId)).eligible).toBe(false);
    }
  });

  it('blocks only a structured deterministic policy conflict and preserves queued successors', async () => {
    const first = await allocation();
    await service.setPause(alice, first.allocationId, 'owner', true);
    await dispatchOnePolicy(service, { gatewayUrl: 'https://edge.example.test/internal/v1/recipient-policies', key,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'policy_revision_conflict' }, { status: 409 })) });
    expect((await pool.query("SELECT count(*) FROM address_policy_outbox WHERE status = 'blocked'")).rows[0].count).toBe('1');
    expect(await dispatchOnePolicy(service, { gatewayUrl: 'https://edge.example.test/internal/v1/recipient-policies', key, fetch: vi.fn<typeof fetch>() })).toBe(false);
    expect((await pool.query('SELECT count(*) FROM address_policy_history')).rows[0].count).toBe('2');
    const blocked = (await pool.query('SELECT last_error_code FROM address_policy_outbox WHERE status = \'blocked\'')).rows[0];
    expect(blocked.last_error_code).toBe('policy_revision_conflict');
    expect((await service.listForActor(alice)).addresses[0]?.policyStatus).toBe('blocked');
    expect((await service.listForActor(alice)).addresses[0]?.policyError).toBe('policy_revision_conflict');
  });

  it.each(['Support', 'info', 'billing', 'mailer-daemon', 'dmarc', 'bounce', 'hr', 'payroll', 'noc', 'ftp', 'a+b', 'x/y', '_alice', 'alice-'])('does not allocate privileged or unusual first-login username %s automatically', async (username) => {
    await pool.query('UPDATE principals SET username = $2 WHERE id = $1', [alice, username]);
    const mailbox = await service.provisionFirstMailbox(alice);
    expect(mailbox.provisioning_status).toBe('needs_address');
    expect(mailbox.provisioning_code).toMatch(/reserved_address|invalid_automatic_username/);
    expect((await pool.query('SELECT count(*) FROM address_allocations')).rows[0].count).toBe('0');
  });

  it('allows an ordinary plus alias only after approval and reserves configured role names for direct administration', async () => {
    await pool.query('UPDATE principals SET username = \'a+b\' WHERE id = $1', [alice]);
    const mailbox = await service.provisionFirstMailbox(alice);
    const request = await service.requestAddress(alice, { address: 'a+b@example.test' });
    expect((await service.approveRequest(adminId, request.id)).mailbox_id).toBe(mailbox.id);
    const custom = new AddressService(pool, { ...config, reservedLocalParts: ['Finance'] }, resolve);
    await pool.query('UPDATE principals SET username = \'Finance\' WHERE id = $1', [bob]);
    const bobMailbox = await custom.provisionFirstMailbox(bob);
    expect(bobMailbox.provisioning_code).toBe('reserved_address');
    await expect(custom.requestAddress(bob, { address: 'finance@example.test' })).rejects.toMatchObject({ code: 'reserved_address' });
    await expect(service.requestAddress(alice, { address: 'support@example.test' })).rejects.toMatchObject({ code: 'reserved_address' });
    expect((await custom.addAddress(adminId, { address: 'finance@example.test', mailboxId: bobMailbox.id })).address).toBe('finance@example.test');
  });

  it('does not claim ownerless legacy addresses seeded after the registry migration', async () => {
    const legacyId = randomUUID();
    await seedMailbox(pool, { id: legacyId, address: 'alice@example.test', name: 'Legacy test inbox' });
    const mailbox = await service.provisionFirstMailbox(alice);
    expect(mailbox.id).not.toBe(legacyId);
    expect(mailbox.provisioning_code).toBe('legacy_route_cutover_required');
    expect((await pool.query('SELECT enabled FROM recipient_routes WHERE mailbox_id = $1', [legacyId])).rows[0].enabled).toBe(true);
  });

  it('supersedes a blocked revision and reaches the newest pause snapshot without replaying intermediate enable policies', async () => {
    const first = await allocation();
    await accept(await latest(first.address));
    await service.setPause(alice, first.allocationId, 'owner', true);
    await accept(await latest(first.address));
    await service.setPause(alice, first.allocationId, 'owner', false);
    await accept(await latest(first.address));
    await service.setReceiveOnly(adminId, first.allocationId, true);
    const fourth = await latest(first.address);
    await pool.query("UPDATE address_policy_outbox SET status = 'blocked', last_error_code = 'policy_revision_conflict' WHERE operation_id = $1", [fourth.operationId]);
    await service.setReceiveOnly(adminId, first.allocationId, false);
    await service.setPause(alice, first.allocationId, 'owner', true);
    const latestPause = await latest(first.address);
    expect(latestPause.revision).toBe(6);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const policy = JSON.parse(String(init?.body)) as RoutePolicy;
      expect(policy).toEqual(latestPause);
      expect(policy.receiveEnabled).toBe(false);
      return Response.json(await ack(policy));
    });
    expect(await dispatchOnePolicy(service, { gatewayUrl: 'https://edge.example.test/internal/v1/recipient-policies', key, fetch: fetcher })).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT count(*) FROM address_policy_outbox WHERE status = 'superseded'")).rows[0].count).toBe('2');
    expect((await service.listForActor(alice)).addresses[0]?.policyAcknowledged).toBe(true);
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('address_paused');
    expect((await pool.query('SELECT count(*) FROM address_policy_history')).rows[0].count).toBe('6');
  });

  it.each(['ack', 'failure'])('fences an older in-flight operation after a newer pause when its late response is %s', async (result) => {
    const first = await allocation();
    const older = await latest(first.address);
    let started!: () => void;
    let finish!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const finishPromise = new Promise<void>((resolve) => { finish = resolve; });
    const oldDispatch = dispatchOnePolicy(service, { gatewayUrl: 'https://edge.example.test/internal/v1/recipient-policies', key,
      fetch: vi.fn<typeof fetch>().mockImplementation(async () => { started(); await finishPromise; if (result === 'failure') throw new Error('Late failure'); return Response.json(await ack(older)); }) });
    await startedPromise;
    try {
      await service.setPause(alice, first.allocationId, 'owner', true);
      const pause = await latest(first.address);
      await dispatchOnePolicy(service, { gatewayUrl: 'https://edge.example.test/internal/v1/recipient-policies', key,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(await ack(pause))) });
    } finally { finish(); await oldDispatch; }
    const old = (await pool.query('SELECT status,lease_id FROM address_policy_outbox WHERE operation_id = $1', [older.operationId])).rows[0];
    expect(old).toEqual({ status: 'superseded', lease_id: null });
    expect((await service.resolveSenderEligibility(alice, first.allocationId)).reason).toBe('address_paused');
    expect((await service.listForActor(alice)).addresses[0]?.policyAcknowledged).toBe(true);
  });

  it('preserves legacy routing and requires explicit cutover before every lifecycle mutation', async () => {
    const legacySchema = `${schema}_legacy`;
    await admin.query(`CREATE SCHEMA "${legacySchema}"`);
    const legacyPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${legacySchema}`, connectionTimeoutMillis: 5000 });
    try {
      await legacyPool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
      for (const name of ['001_inbound.sql', '002_casefold_recipients.sql', '003_auth.sql']) {
        await legacyPool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
        await legacyPool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      }
      const id = randomUUID();
      await seedMailbox(legacyPool, { id, address: 'legacy@example.test', name: 'Legacy mailbox' });
      await migrate(legacyPool);
      expect((await legacyPool.query('SELECT id,owner_principal_id FROM mailboxes')).rows).toEqual([{ id, owner_principal_id: null }]);
      const imported = (await legacyPool.query('SELECT * FROM address_allocations')).rows[0];
      expect(imported.mailbox_id).toBe(id);
      expect((await legacyPool.query('SELECT count(*) FROM address_send_grants')).rows[0].count).toBe('0');
      const legacyService = new AddressService(legacyPool, config, async () => ({ principalId: adminId, issuer, subject: adminId, username: 'postmaster', roleId: 0, permissions: new Set(['addresses.manage', 'mailbox.use']) }));
      await legacyPool.query('INSERT INTO principals(id,issuer,subject,app_role,access_enabled) VALUES ($1,$2,$3,0,true)', [adminId, issuer, adminId]);
      const anotherMailbox = randomUUID();
      await legacyPool.query('INSERT INTO mailboxes(id,address,name) VALUES ($1,\'legacy@example.test\',\'Another history\')', [anotherMailbox]);
      for (const operation of [
        () => legacyService.setPause(adminId, imported.id, 'admin', true),
        () => legacyService.setPause(adminId, imported.id, 'admin', false),
        () => legacyService.setReceiveOnly(adminId, imported.id, false),
        () => legacyService.setSendGrant(adminId, imported.id, adminId, false),
        () => legacyService.removeAddress(adminId, imported.id),
        () => legacyService.addAddress(adminId, { address: 'legacy@example.test', mailboxId: anotherMailbox }, 'reassigned'),
        () => legacyService.addAddress(adminId, { address: 'legacy@example.test', mailboxId: id }, 'reactivated'),
      ]) await expect(operation()).rejects.toMatchObject({ statusCode: 409, code: 'legacy_route_cutover_required' });
      expect((await legacyPool.query('SELECT mailbox_id,enabled FROM recipient_routes')).rows).toEqual([{ mailbox_id: id, enabled: true }]);
      expect((await legacyPool.query('SELECT count(*) FROM address_policy_history')).rows[0].count).toBe('0');
      expect((await legacyPool.query('SELECT ended_at, receive_only FROM address_allocations WHERE id = $1', [imported.id])).rows).toEqual([{ ended_at: null, receive_only: true }]);
    } finally { await legacyPool.end(); await admin.query(`DROP SCHEMA "${legacySchema}" CASCADE`); }
  });
});
