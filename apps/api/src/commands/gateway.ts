import { parseArgs } from 'node:util';
import { access, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { GatewayClient, GatewayClientError } from '../gateway-client.js';
import { AddressOperatorService } from '../addresses/operator.js';
import { ApiError } from '../errors.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  address: { type: 'string' }, operator: { type: 'string' }, 'operation-id': { type: 'string' },
  'plan-id': { type: 'string' }, 'plan-digest': { type: 'string' }, 'worker-version': { type: 'string' },
  'after-delivery-id': { type: 'string' }, output: { type: 'string' },
} });
if (values.output) {
  try { await access(values.output); throw new Error('Operator output already exists; choose a new evidence file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const action = positionals[0];
const actions = ['inspect', 'operation-status', 'prepare', 'stage', 'verify-staged', 'confirm', 'reconcile-plan', 'reconcile-apply', 'reconcile-recover'];
if (!action || !actions.includes(action) || positionals.length !== 1) throw new Error(`Use one of: ${actions.join(', ')}`);
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing operator configuration: ${name}`); return value; }
function argument(name: keyof typeof values): string { const value = values[name]; if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`); return value; }
const allowedAddresses = required('GATEWAY_ALLOWED_ADDRESSES').split(',').map(address => address.trim().toLowerCase()).filter(Boolean);
const expectedGatewayId = required('GATEWAY_ID');
const gateway = new GatewayClient({ operatorUrl: required('GATEWAY_OPERATOR_URL'),
  operatorKey: { id: required('GATEWAY_OPERATOR_KEY_ID'), secret: required('GATEWAY_OPERATOR_SECRET') },
  policyKey: { id: required('POLICY_KEY_ID'), secret: required('POLICY_SECRET') }, expectedGatewayId,
  allowedAddresses, allowInsecureLoopback: process.env.ALLOW_INSECURE_LOCAL_GATEWAY === 'true' });
const pool = new pg.Pool({ connectionString: required('DATABASE_URL'), connectionTimeoutMillis: 5000 });
try {
  const service = new AddressOperatorService(pool, { allowedAddresses }, gateway);
  let result: unknown;
  switch (action) {
    case 'inspect': result = await gateway.inspect(argument('address'), values['after-delivery-id']); break;
    case 'operation-status': result = await gateway.operationStatus(argument('address'), argument('operation-id')); break;
    case 'verify-staged': result = await service.verifyStaged(argument('address'), expectedGatewayId, argument('worker-version'), argument('operator')); break;
    case 'reconcile-recover': result = await service.recoverReconciliation(argument('plan-id'), argument('plan-digest'), argument('operator')); break;
    case 'prepare': result = await service.prepareLegacy(argument('address'), argument('operator')); break;
    case 'stage': result = await service.stageLegacy(argument('operation-id'), argument('operator')); break;
    case 'confirm': {
      const address = argument('address');
      result = await service.markDynamicCompatibility(address, await gateway.inspect(address), expectedGatewayId, argument('worker-version'), argument('operator'));
      break;
    }
    case 'reconcile-plan': result = await service.planReconciliation(argument('address'), expectedGatewayId, argument('worker-version'), argument('operator')); break;
    case 'reconcile-apply': result = await service.applyReconciliation(argument('plan-id'), argument('plan-digest'), argument('operator')); break;
  }
  const output = JSON.stringify(result, null, 2) + '\n';
  if (values.output) {
    try { await writeFile(values.output, output, { flag: 'wx', mode: 0o600 }); console.log('Operator result saved to the requested new file.'); }
    catch {
      // The operation already completed; retain its result rather than misreporting a failed mutation.
      console.error('Operator action completed, but the evidence file could not be written. The result follows on stdout.');
      console.log(output); process.exitCode = 2;
    }
  } else console.log(output);
} catch (error) {
  console.error(error instanceof GatewayClientError || error instanceof ApiError ? error.code : 'gateway_operator_failed');
  process.exitCode = 1;
} finally { await pool.end(); }
