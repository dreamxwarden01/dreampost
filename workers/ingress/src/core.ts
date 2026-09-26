import { createDeliveryHeaders, matchesAck, MAX_INBOUND_BYTES, normalizeRecipientAddress, sha256Hex, validateMetadata } from '@dreampost/protocol';
import type { DeliveryMetadata } from '@dreampost/protocol';
import type { GatewayConfig } from './config.js';
import type { DeliveryRecord, DeliveryResult, InboundMessage, Ledger, RawStore, StoredRaw, WakeQueue } from './model.js';

export const LEASE_MS = 300_000;
export const REQUEUE_AFTER_MS = 300_000;
const MAX_RESPONSE_BYTES = 4096;
const permanentErrors: Readonly<Record<number, string>> = {
  400: 'delivery_body_mismatch',
  409: 'delivery_id_conflict',
  413: 'message_too_large',
  415: 'unsupported_content_type',
  422: 'recipient_not_configured',
};

export function pushTimeoutMs(rawSize: number): number {
  return Math.min(150_000, 30_000 + Math.ceil(rawSize / (256 * 1024)) * 1000);
}

function isPermanentRejection(status: number, value: unknown): boolean {
  return Object.hasOwn(permanentErrors, status) && value !== null && typeof value === 'object'
    && !Array.isArray(value) && (value as { error?: unknown }).error === permanentErrors[status];
}

interface Dependencies {
  ledger: Ledger;
  raw: RawStore;
  queue: WakeQueue;
  config: GatewayConfig;
  fetch: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  log?: (event: string, deliveryId?: string) => void;
}

export async function readBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new BodyLimitError('Body limit exceeded');
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function sameMetadata(a: DeliveryMetadata, b: DeliveryMetadata): boolean {
  if (a.version !== b.version || a.deliveryId !== b.deliveryId || a.mailboxId !== b.mailboxId
    || a.envelopeFrom !== b.envelopeFrom || a.envelopeTo !== b.envelopeTo
    || a.receivedAt !== b.receivedAt || a.rawSize !== b.rawSize) return false;
  return a.version === 1 || (b.version === 2 && a.allocationId === b.allocationId
    && a.routeRevision === b.routeRevision && a.policyDigest === b.policyDigest);
}

export class Gateway {
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly log: (event: string, deliveryId?: string) => void;
  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => undefined);
  }

  async receive(message: InboundMessage): Promise<void> {
    // Signed metadata always retains the original SMTP envelope spelling.
    const recipient = normalizeRecipientAddress(message.to);
    if (!Number.isSafeInteger(message.rawSize) || message.rawSize < 1 || message.rawSize > MAX_INBOUND_BYTES) {
      message.setReject('Message size is not supported'); return;
    }
    const now = this.now();
    const deliveryId = this.uuid();
    const token = this.uuid();
    const makeRecord = (metadata: DeliveryMetadata): DeliveryRecord => ({
      deliveryId, metadata, sha256: null, state: 'receiving', createdAt: now, updatedAt: now,
      nextAttemptAt: now + LEASE_MS, lastEnqueuedAt: null, leaseToken: token, leaseUntil: now + LEASE_MS,
      attempts: 0, lastError: null,
    });
    const base = { deliveryId, envelopeFrom: message.from, envelopeTo: message.to,
      receivedAt: new Date(now).toISOString(), rawSize: message.rawSize };
    let record: DeliveryRecord | undefined;
    if (this.deps.config.routingMode === 'dynamic') {
      const domain = recipient.slice(recipient.lastIndexOf('@') + 1);
      if (!this.deps.config.allowedPolicyDomains.includes(domain)) {
        message.setReject('Recipient is not configured'); return;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await this.deps.ledger.getPolicy(recipient);
        if (!current || !current.policy.receiveEnabled) {
          message.setReject('Recipient is not configured'); return;
        }
        const candidate = makeRecord(validateMetadata({ ...base, version: 2, mailboxId: current.policy.mailboxId,
          allocationId: current.policy.allocationId, routeRevision: current.policy.revision, policyDigest: current.sha256 }));
        if (await this.deps.ledger.admitDynamic(candidate, recipient)) { record = candidate; break; }
      }
      // A race or database failure is not a deterministic SMTP policy rejection.
      if (!record) throw new Error('Recipient policy changed during admission');
    } else {
      const mailboxId = Object.hasOwn(this.deps.config.routes, recipient) ? this.deps.config.routes[recipient] : undefined;
      if (!mailboxId) { message.setReject('Recipient is not configured'); return; }
      record = makeRecord(validateMetadata({ ...base, version: 1, mailboxId }));
      await this.deps.ledger.insert(record);
    }
    const metadata = record.metadata;
    const bytes = await readBounded(message.raw, MAX_INBOUND_BYTES);
    if (bytes.byteLength !== metadata.rawSize) throw new Error('Raw size mismatch');
    const digest = await sha256Hex(bytes);
    await this.deps.raw.put(record.deliveryId, bytes, metadata, digest);
    try {
      const stored = await this.deps.ledger.updateOwned(record.deliveryId, token, 'receiving', {
        state: 'stored', sha256: digest, updatedAt: this.now(), nextAttemptAt: this.now(), leaseToken: null, leaseUntil: null,
      });
      if (!stored) {
        this.log('receipt_finalization_deferred', record.deliveryId);
        return;
      }
    } catch {
      // R2 definitively accepted complete bytes. The receiving record lets repair finish safely.
      this.log('receipt_finalization_deferred', record.deliveryId);
      return;
    }
    // Failure here is safe: the durable ledger is discoverable by scheduled repair.
    await this.enqueue(record.deliveryId);
  }

  private async enqueue(id: string): Promise<void> {
    try {
      await this.deps.queue.send({ deliveryId: id });
      await this.deps.ledger.noteEnqueued(id, this.now());
    } catch { this.log('enqueue_failed', id); }
  }

  private async checkedRaw(record: DeliveryRecord): Promise<{ raw: StoredRaw; digest: string } | null> {
    const raw = await this.deps.raw.get(record.deliveryId);
    if (!raw) return null;
    let metadata: DeliveryMetadata;
    try { metadata = validateMetadata(raw.metadata); } catch { throw new IntegrityError(); }
    const digest = await sha256Hex(raw.bytes);
    if (!sameMetadata(metadata, record.metadata) || raw.bytes.byteLength !== record.metadata.rawSize
      || raw.sha256 !== digest || (record.sha256 !== null && record.sha256 !== digest)) throw new IntegrityError();
    return { raw, digest };
  }

  async deliver(id: string): Promise<DeliveryResult> {
    const current = await this.deps.ledger.get(id);
    if (!current) { this.log('missing_delivery_record', id); return { action: 'ack' }; }
    if (current.state === 'done' || current.state === 'blocked') return { action: 'ack' };
    if (current.state === 'delivered_pending_delete') return this.cleanup(current);
    if (current.state === 'receiving') return { action: 'retry', delaySeconds: 60 };
    const token = this.uuid();
    const record = await this.deps.ledger.claim(id, 'stored', token, this.now(), LEASE_MS);
    if (!record) return { action: 'retry', delaySeconds: 60 };
    let stage = 'raw_read';
    try {
      const checked = await this.checkedRaw(record);
      if (!checked) return this.block(record, token, 'raw_missing');
      stage = 'signing';
      const headers = await createDeliveryHeaders(record.metadata, checked.raw.bytes, this.deps.config.key, {
        nowMs: this.now(), attemptId: this.uuid(),
      });
      stage = 'timeout_setup';
      const signal = AbortSignal.timeout(pushTimeoutMs(record.metadata.rawSize));
      stage = 'http_push';
      const response = await this.deps.fetch(this.deps.config.backendUrl, {
        method: 'POST', headers, body: checked.raw.bytes,
        // Workerd rejects redirect: 'error'; manual prevents forwarding signed credentials.
        redirect: 'manual', signal,
      });
      // Proxies and authentication failures are not authoritative mailbox decisions.
      if (response.status === 401 || response.status === 403 || response.status === 429
        || response.status === 408 || response.status >= 500 || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        return this.retry(record, token, 'backend_unavailable');
      }
      if (!response.body) return this.retry(record, token, 'invalid_backend_response');
      let responseBytes: Uint8Array;
      try { responseBytes = await readBounded(response.body, MAX_RESPONSE_BYTES); }
      catch (error) {
        return this.retry(record, token, error instanceof BodyLimitError ? 'backend_response_too_large' : 'ack_read_failed');
      }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(responseBytes)); }
      catch { return this.retry(record, token, 'invalid_backend_response'); }
      if (response.status !== 200) {
        if (isPermanentRejection(response.status, payload)) return this.block(record, token, 'backend_rejected');
        return this.retry(record, token, 'unrecognized_backend_response');
      }
      if (!matchesAck(payload, { deliveryId: id, sha256: checked.digest })) return this.retry(record, token, 'invalid_ack');
      // Persist delivery before deleting. A lost database write results only in an idempotent HTTP retry.
      stage = 'delivery_record';
      const marked = await this.deps.ledger.updateOwned(id, token, 'stored', {
        state: 'delivered_pending_delete', updatedAt: this.now(), nextAttemptAt: this.now(), lastError: null,
      });
      if (!marked) return { action: 'retry', delaySeconds: 60 };
      return this.cleanup({ ...record, state: 'delivered_pending_delete' }, token);
    } catch (error) {
      if (error instanceof IntegrityError) return this.block(record, token, 'raw_integrity_failed');
      const kind = error instanceof TypeError ? 'type_error' : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error';
      return this.retry(record, token, `delivery_${stage}_${kind}`);
    }
  }

  private async block(record: DeliveryRecord, token: string, code: string): Promise<DeliveryResult> {
    const updated = await this.deps.ledger.updateOwned(record.deliveryId, token, record.state, {
      state: 'blocked', updatedAt: this.now(), lastError: code, leaseToken: null, leaseUntil: null,
    });
    if (updated) this.log(code, record.deliveryId);
    return updated ? { action: 'ack' } : { action: 'retry', delaySeconds: 60 };
  }

  private async retry(record: DeliveryRecord, token: string, code: string): Promise<DeliveryResult> {
    const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(Math.max(0, record.attempts - 1), 7));
    await this.deps.ledger.updateOwned(record.deliveryId, token, record.state, {
      updatedAt: this.now(), nextAttemptAt: this.now() + delaySeconds * 1000,
      leaseToken: null, leaseUntil: null, lastError: code,
    });
    this.log(code, record.deliveryId);
    return { action: 'retry', delaySeconds };
  }

  private async cleanup(record: DeliveryRecord, ownedToken?: string): Promise<DeliveryResult> {
    const token = ownedToken ?? this.uuid();
    const owned = ownedToken ? record : await this.deps.ledger.claim(record.deliveryId, 'delivered_pending_delete', token, this.now(), LEASE_MS);
    if (!owned) return { action: 'retry', delaySeconds: 60 };
    try {
      await this.deps.raw.delete(record.deliveryId);
      const updated = await this.deps.ledger.updateOwned(record.deliveryId, token, 'delivered_pending_delete', {
        state: 'done', updatedAt: this.now(), leaseToken: null, leaseUntil: null, lastError: null,
      });
      return updated ? { action: 'ack' } : { action: 'retry', delaySeconds: 60 };
    } catch { return this.retry({ ...owned, state: 'delivered_pending_delete' }, token, 'cleanup_failed'); }
  }

  async repair(): Promise<void> {
    const records = await this.deps.ledger.due(this.now(), 100, this.now() - REQUEUE_AFTER_MS);
    for (const record of records) {
      try {
        if (record.state === 'receiving') await this.recoverReceipt(record);
        else if (record.state === 'delivered_pending_delete') await this.cleanup(record);
        else if (record.state === 'stored' && (record.lastEnqueuedAt === null || record.lastEnqueuedAt <= this.now() - REQUEUE_AFTER_MS)) {
          await this.enqueue(record.deliveryId);
        }
      } catch { this.log('repair_failed', record.deliveryId); }
    }
    try {
      await this.deps.ledger.purgeDone(this.now() - this.deps.config.doneRetentionDays * 86400_000, 100);
    } catch { this.log('tombstone_cleanup_failed'); }
  }

  private async recoverReceipt(record: DeliveryRecord): Promise<void> {
    const token = this.uuid();
    const owned = await this.deps.ledger.claim(record.deliveryId, 'receiving', token, this.now(), LEASE_MS);
    if (!owned) return;
    try {
      const checked = await this.checkedRaw(owned);
      if (!checked) {
        // Missing may mean an interrupted or still-running upload. Age is never authority to delete.
        await this.retry(owned, token, 'receiving_raw_missing');
        return;
      }
      const stored = await this.deps.ledger.updateOwned(record.deliveryId, token, 'receiving', {
        state: 'stored', sha256: checked.digest, updatedAt: this.now(), nextAttemptAt: this.now(),
        leaseToken: null, leaseUntil: null, lastError: null,
      });
      if (stored) await this.enqueue(record.deliveryId);
    } catch (error) {
      if (error instanceof IntegrityError) await this.block(owned, token, 'receiving_integrity_failed');
      else await this.retry(owned, token, 'receiving_recovery_failed');
    }
  }
}

class IntegrityError extends Error {}
export class BodyLimitError extends Error {}
