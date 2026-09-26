import { MAX_POLICY_BYTES, POLICY_PATH, verifyPolicyRequest } from '@dreampost/protocol';
import type { PolicyAck, PreparedPolicyAck } from '@dreampost/protocol';
import type { GatewayConfig } from './config.js';
import { BodyLimitError, readBounded } from './core.js';
import type { Ledger } from './model.js';

function result(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function handlePolicyRequest(request: Request, config: GatewayConfig, ledger: Ledger,
  now: () => number = Date.now): Promise<Response> {
  const url = new URL(request.url);
  if ((config.routingMode !== 'dynamic' && !config.allowStaticPreload) || url.pathname !== POLICY_PATH) return result(404, { error: 'not_found' });
  if (request.method !== 'POST') return result(405, { error: 'method_not_allowed' });
  if (url.search) return result(400, { error: 'invalid_policy_request' });
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_POLICY_BYTES)) {
    return result(413, { error: 'policy_too_large' });
  }
  if (!request.body) return result(400, { error: 'policy_body_required' });
  let bytes: Uint8Array;
  try { bytes = await readBounded(request.body, MAX_POLICY_BYTES); }
  catch (error) { return result(error instanceof BodyLimitError ? 413 : 400, { error: 'invalid_policy_body' }); }
  let verified: Awaited<ReturnType<typeof verifyPolicyRequest>>;
  try { verified = await verifyPolicyRequest(request.headers, bytes, config.policyKeys, { nowMs: now() }); }
  catch { return result(401, { error: 'invalid_policy_authorization' }); }
  const { policy, digest } = verified;
  const domain = policy.address.slice(policy.address.lastIndexOf('@') + 1);
  if (!config.allowedPolicyDomains.includes(domain)) return result(403, { error: 'policy_domain_not_allowed' });
  if (config.policyAllowedAddresses && !config.policyAllowedAddresses.includes(policy.address)) {
    return result(403, { error: 'policy_address_not_allowed' });
  }
  const preparing = config.routingMode === 'static';
  if (preparing && (!config.policyAllowedAddresses?.includes(policy.address) || !policy.receiveEnabled
    || !Object.hasOwn(config.routes, policy.address) || config.routes[policy.address] !== policy.mailboxId)) {
    return result(403, { error: 'static_preload_binding_mismatch' });
  }
  try {
    if (await ledger.applyPolicy(policy, digest, now()) !== 'applied') return result(409, { error: 'policy_revision_conflict' });
    const ack: PolicyAck | PreparedPolicyAck = { version: 1, operationId: policy.operationId, address: policy.address,
      revision: policy.revision, sha256: digest, status: preparing ? 'prepared' : 'applied' };
    return result(preparing ? 202 : 200, ack);
  } catch { return result(503, { error: 'policy_temporarily_unavailable' }); }
}
