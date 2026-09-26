import { randomUUID } from 'node:crypto';
import {
  GATEWAY_OPERATION_PATH, MAX_GATEWAY_RESPONSE_BYTES, POLICY_PATH, MAX_POLICY_BYTES,
  createGatewayOperationHeaders, verifyGatewayResponse, createPolicyHeaders, hashRoutePolicy,
  matchesPolicyAck, validateRoutePolicy, normalizeRecipientAddress,
  type GatewayOperation, type GatewayOperationResponse, type GatewayInspection, type GatewayOperationStatus,
  type PreparedPolicyAck, type PolicyAck, type RemotePolicyExpectation, type RoutePolicy, type SigningKey,
} from '@dreampost/protocol';

export interface GatewayClientConfig {
  operatorUrl: string;
  operatorKey: SigningKey;
  policyKey: SigningKey;
  expectedGatewayId: string;
  allowedAddresses: readonly string[];
  allowInsecureLoopback?: boolean;
}
export class GatewayClientError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'GatewayClientError'; }
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new GatewayClientError('gateway_response_missing');
  const parts: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new GatewayClientError('gateway_response_too_large'); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(length); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}
export class GatewayClient {
  private readonly url: URL;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly addresses: Set<string>;
  constructor(readonly config: GatewayClientConfig, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.url = new URL(config.operatorUrl);
    const loopback = config.allowInsecureLoopback && this.url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname);
    if ((this.url.protocol !== 'https:' && !loopback) || this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== GATEWAY_OPERATION_PATH) {
      throw new Error('Invalid operator endpoint; use the exact HTTPS gateway operation URL');
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(config.expectedGatewayId)) throw new Error('An explicit gateway identity is required');
    for (const key of [config.operatorKey, config.policyKey]) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key.id) || Buffer.byteLength(key.secret) < 32) throw new Error('Invalid gateway credential');
    }
    if (config.operatorKey.secret === config.policyKey.secret) throw new Error('Operator and ordinary policy credentials must be separate');
    this.addresses = new Set(config.allowedAddresses.map(normalizeRecipientAddress));
    if (!this.addresses.size || [...this.addresses].some(address => address.includes('*'))) throw new Error('Exact operator recipient scope is required');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis); this.now = options.now ?? Date.now;
  }
  private scope(address: string): void {
    if (!this.addresses.has(address) || normalizeRecipientAddress(address) !== address) throw new GatewayClientError('operator_recipient_not_allowed');
  }
  private async operation(operation: GatewayOperation): Promise<GatewayOperationResponse> {
    this.scope(operation.kind === 'reconcile' ? operation.policy.address : operation.address);
    let response: Response;
    try {
      response = await this.fetcher(this.url, { method: 'POST', headers: await createGatewayOperationHeaders(operation, this.config.operatorKey, { nowMs: this.now() }),
        body: JSON.stringify(operation), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch { throw new GatewayClientError('gateway_operation_unavailable'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new GatewayClientError('gateway_redirect_refused'); }
    const raw = await bounded(response, MAX_GATEWAY_RESPONSE_BYTES);
    let result: GatewayOperationResponse;
    try { result = await verifyGatewayResponse(response.headers, raw, { [this.config.operatorKey.id]: this.config.operatorKey.secret }, operation.requestId, { nowMs: this.now() }); }
    catch { throw new GatewayClientError('gateway_response_unverified'); }
    if (result.kind === 'error') throw new GatewayClientError(result.error);
    if (!response.ok) throw new GatewayClientError('gateway_response_status_mismatch');
    return result;
  }
  async inspect(address: string, afterDeliveryId?: string): Promise<GatewayInspection> {
    const result = await this.operation({ version: 1, kind: 'inspect', requestId: randomUUID(), gatewayId: this.config.expectedGatewayId, address,
      ...(afterDeliveryId ? { afterDeliveryId } : {}) });
    if (result.kind !== 'inspection' || result.address !== address || result.gatewayId !== this.config.expectedGatewayId
      || result.inspectedAt > this.now() + 5000 || this.now() - result.inspectedAt > 60_000) throw new GatewayClientError('gateway_inspection_mismatch');
    if (result.policy && await hashRoutePolicy(result.policy.policy) !== result.policy.sha256) throw new GatewayClientError('gateway_policy_digest_mismatch');
    return result;
  }
  async operationStatus(address: string, operationId: string): Promise<GatewayOperationStatus> {
    const result = await this.operation({ version: 1, kind: 'operation-status', requestId: randomUUID(), gatewayId: this.config.expectedGatewayId, address, operationId });
    if (result.kind !== 'operation-status' || result.address !== address || result.operationId !== operationId
      || result.gatewayId !== this.config.expectedGatewayId || result.inspectedAt > this.now() + 5000 || this.now() - result.inspectedAt > 60_000) {
      throw new GatewayClientError('gateway_operation_status_mismatch');
    }
    if (result.record && await hashRoutePolicy(result.record.policy) !== result.record.sha256) throw new GatewayClientError('gateway_policy_digest_mismatch');
    return result;
  }
  async stage(policy: RoutePolicy): Promise<PreparedPolicyAck> {
    const normalized = validateRoutePolicy(policy); this.scope(normalized.address);
    const sha256 = await hashRoutePolicy(normalized);
    const response = await this.fetcher(new URL(POLICY_PATH, this.url.origin), { method: 'POST',
      headers: await createPolicyHeaders(normalized, this.config.policyKey, { nowMs: this.now() }),
      body: JSON.stringify(normalized), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status !== 202) { await response.body?.cancel(); throw new GatewayClientError('gateway_preparation_not_confirmed'); }
    let ack: unknown; try { ack = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(response, MAX_POLICY_BYTES))); }
    catch { throw new GatewayClientError('gateway_preparation_ack_invalid'); }
    if (!ack || typeof ack !== 'object' || (ack as { status?: unknown }).status !== 'prepared'
      || !matchesPolicyAck({ ...ack, status: 'applied' }, { ...normalized, sha256 })) throw new GatewayClientError('gateway_preparation_ack_mismatch');
    return ack as PreparedPolicyAck;
  }
  async reconcile(policy: RoutePolicy, expectedRemote: RemotePolicyExpectation): Promise<PolicyAck> {
    const normalized = validateRoutePolicy(policy); this.scope(normalized.address);
    const result = await this.operation({ version: 1, kind: 'reconcile', requestId: randomUUID(), gatewayId: this.config.expectedGatewayId, policy: normalized, expectedRemote });
    if (result.kind !== 'reconciled' || !matchesPolicyAck(result.ack, { ...normalized, sha256: await hashRoutePolicy(normalized) })) {
      throw new GatewayClientError('gateway_reconciliation_ack_mismatch');
    }
    return result.ack;
  }
}
