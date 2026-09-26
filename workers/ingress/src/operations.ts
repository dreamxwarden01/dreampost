import {
  GATEWAY_OPERATION_PATH, MAX_GATEWAY_OPERATION_BYTES, hashRoutePolicy, signGatewayResponse, verifyGatewayOperation,
  type GatewayInspection, type GatewayOperationResponse, type PolicyAck,
} from '@dreampost/protocol';
import type { GatewayConfig } from './config.js';
import { BodyLimitError, readBounded } from './core.js';
import type { Ledger } from './model.js';

const plain = (status: number, error: string) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function handleOperationRequest(request: Request, config: GatewayConfig, ledger: Ledger,
  workerVersion: string | null = null, now: () => number = Date.now): Promise<Response> {
  const url = new URL(request.url);
  if (!config.operator || url.pathname !== GATEWAY_OPERATION_PATH) return plain(404, 'not_found');
  if (request.method !== 'POST') return plain(405, 'method_not_allowed');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_GATEWAY_OPERATION_BYTES)) return plain(413, 'operator_request_too_large');
  if (!request.body) return plain(401, 'invalid_operator_authorization');
  let bytes: Uint8Array;
  try { bytes = await readBounded(request.body, MAX_GATEWAY_OPERATION_BYTES); }
  catch (error) { return plain(error instanceof BodyLimitError ? 413 : 401, 'invalid_operator_authorization'); }
  let verified: Awaited<ReturnType<typeof verifyGatewayOperation>>;
  try { verified = await verifyGatewayOperation(request.headers, bytes, config.operator.keys, { nowMs: now() }); }
  catch { return plain(401, 'invalid_operator_authorization'); }
  const { operation, keyId } = verified;
  const key = { id: keyId, secret: config.operator.keys[keyId]! };
  async function signed(status: number, value: GatewayOperationResponse): Promise<Response> {
    const headers = await signGatewayResponse(value, operation.requestId, key, { nowMs: now() });
    return new Response(JSON.stringify(value), { status, headers: { ...headers, 'Cache-Control': 'no-store' } });
  }
  const error = (status: number, code: string) => signed(status, { version: 1, kind: 'error', requestId: operation.requestId, error: code });
  if (operation.gatewayId !== config.operator.gatewayId) return error(403, 'gateway_identity_mismatch');
  if (url.search) return error(400, 'operator_query_not_allowed');
  const address = operation.kind === 'reconcile' ? operation.policy.address : operation.address;
  if (!config.operator.allowedAddresses.includes(address)) return error(403, 'operator_address_not_allowed');
  try {
    if (operation.kind === 'inspect') {
      const inspectedAt = now();
      const snapshot = await ledger.inspectRecipient(address, operation.afterDeliveryId, inspectedAt);
      const inspection: GatewayInspection = { version: 1, kind: 'inspection', requestId: operation.requestId,
        address, gatewayId: config.operator.gatewayId, workerVersion, routingMode: config.routingMode, inspectedAt,
        policyAllowedAddresses: config.policyAllowedAddresses ?? null,
        staticMailboxId: Object.hasOwn(config.routes, address) ? config.routes[address]! : null, ...snapshot };
      return signed(200, inspection);
    }
    if (operation.kind === 'operation-status') {
      const record = await ledger.getAppliedOperation(address, operation.operationId);
      return signed(200, { version: 1, kind: 'operation-status', requestId: operation.requestId, address,
        gatewayId: config.operator.gatewayId, workerVersion, inspectedAt: now(), operationId: operation.operationId, record });
    }
    if (config.routingMode !== 'dynamic') return error(409, 'gateway_not_dynamic');
    const domain = address.slice(address.lastIndexOf('@') + 1);
    if (!config.allowedPolicyDomains.includes(domain)
      || (config.policyAllowedAddresses && !config.policyAllowedAddresses.includes(address))) {
      return error(403, 'policy_address_not_allowed');
    }
    const digest = await hashRoutePolicy(operation.policy);
    // The expected remote revision and digest are checked in the same D1 transaction as the write.
    const outcome = await ledger.applyPolicy(operation.policy, digest, now(), operation.expectedRemote);
    if (outcome !== 'applied') return error(409, 'policy_precondition_failed');
    const ack: PolicyAck = { version: 1, status: 'applied', operationId: operation.policy.operationId,
      address, revision: operation.policy.revision, sha256: digest };
    return signed(200, { version: 1, kind: 'reconciled', requestId: operation.requestId, ack });
  } catch { return error(503, 'operator_temporarily_unavailable'); }
}
