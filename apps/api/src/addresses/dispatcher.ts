import { randomUUID } from 'node:crypto';
import { createPolicyHeaders, POLICY_PATH, MAX_POLICY_BYTES, validateRoutePolicy, matchesPolicyAck, type RoutePolicy, type SigningKey } from '@dreampost/protocol';
import type { AddressService } from './service.js';

export interface PolicyDispatchOptions {
  gatewayUrl: string;
  key: SigningKey;
  fetch?: typeof fetch;
  allowInsecureLoopback?: boolean;
}
interface ClaimedPolicy { operation_id: string; payload: RoutePolicy; sha256: string; attempts: number }

async function readAck(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('invalid_policy_ack');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_POLICY_BYTES) { await reader.cancel(); throw new Error('invalid_policy_ack'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Processes one durable policy operation. Never runs within a user's mutation transaction. */
export async function dispatchOnePolicy(service: AddressService, options: PolicyDispatchOptions): Promise<boolean> {
  const url = new URL(options.gatewayUrl);
  const localHttp = options.allowInsecureLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.pathname !== POLICY_PATH || url.search || url.hash || url.username || url.password) {
    throw new Error('The policy gateway URL must be HTTPS and use the exact recipient policy path.');
  }
  const leaseId = randomUUID();
  const client = await service.pool.connect();
  let claimed: ClaimedPolicy | undefined;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<ClaimedPolicy>(
      `SELECT o.operation_id, h.payload, h.sha256, o.attempts FROM address_registry r
       JOIN address_policy_history h ON h.address = r.address AND h.revision = r.policy_revision
       JOIN address_policy_outbox o ON o.operation_id = h.operation_id
       WHERE ((o.status = 'pending' AND o.available_at <= now()) OR (o.status = 'inflight' AND o.lease_until <= now()))
       ORDER BY h.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
    );
    claimed = rows[0];
    if (claimed) {
      const leased = await client.query(`UPDATE address_policy_outbox SET status = 'inflight', attempts = attempts + 1,
        lease_id = $2, lease_until = now() + interval '1 minute' WHERE operation_id = $1
        AND ((status = 'pending' AND available_at <= now()) OR (status = 'inflight' AND lease_until <= now()))
        RETURNING operation_id`, [claimed.operation_id, leaseId]);
      if (!leased.rowCount) claimed = undefined;
      else await client.query(`UPDATE address_policy_outbox o SET status = 'superseded', superseded_at = COALESCE(superseded_at,now()),
        lease_id = NULL, lease_until = NULL, last_error_code = NULL FROM address_policy_history h
        WHERE h.operation_id = o.operation_id AND h.address = $1 AND h.revision < $2
          AND o.status IN ('pending','inflight','blocked')`, [claimed!.payload.address, claimed!.payload.revision]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  if (!claimed) return false;
  let errorCode = 'policy_network_error';
  let retryable = true;
  try {
    const policy = validateRoutePolicy(claimed.payload);
    const activeLease = await service.pool.query(`SELECT 1 FROM address_policy_outbox o
      JOIN address_policy_history h ON h.operation_id = o.operation_id
      JOIN address_registry r ON r.address = h.address AND r.policy_revision = h.revision
      WHERE o.operation_id = $1 AND o.status = 'inflight' AND o.lease_id = $2`, [claimed.operation_id, leaseId]);
    if (!activeLease.rowCount) return true;
    const response = await (options.fetch ?? fetch)(url, {
      method: 'POST', headers: await createPolicyHeaders(policy, options.key), body: JSON.stringify(policy),
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 200) {
      const ack = await readAck(response);
      if (!matchesPolicyAck(ack, { ...policy, sha256: claimed.sha256 })) {
        errorCode = 'policy_ack_mismatch';
      } else {
        await service.acknowledgePolicy(ack);
        return true;
      }
    } else {
      errorCode = response.status >= 300 && response.status < 400 ? 'policy_redirect_blocked' : `policy_http_${response.status}`;
      if (response.headers.get('content-type')?.includes('application/json') && [403, 409].includes(response.status)) {
        const failure = await readAck(response) as { error?: unknown } | null;
        if ((response.status === 409 && failure?.error === 'policy_revision_conflict')
          || (response.status === 403 && failure?.error === 'policy_domain_not_allowed')) {
          retryable = false;
          errorCode = String(failure.error);
        }
      } else await response.body?.cancel();
    }
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'invalid_policy_ack')) {
      errorCode = 'policy_ack_invalid';
    }
  }
  const delaySeconds = Math.min(3600, 5 * 2 ** Math.min(claimed.attempts, 10));
  await service.pool.query(`UPDATE address_policy_outbox SET status = $3, lease_id = NULL, lease_until = NULL,
    available_at = now() + $4 * interval '1 second', last_error_code = $5
    WHERE operation_id = $1 AND lease_id = $2 AND status = 'inflight'`,
  [claimed.operation_id, leaseId, retryable ? 'pending' : 'blocked', delaySeconds, errorCode]);
  return true;
}
