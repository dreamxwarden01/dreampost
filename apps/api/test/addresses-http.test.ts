import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/errors.js';
import { registerAddressRoutes, type AddressActor, type AddressService, type AuthenticateAddressRequest } from '../src/addresses/index.js';

const actor: AddressActor = {
  principalId: '11111111-1111-4111-8111-111111111111', issuer: 'https://sso.example.test', subject: 'test-subject',
  username: 'reader', roleId: 1, permissions: new Set(['mailbox.use']),
};
const headers = { cookie: 'session=valid', origin: 'https://mail.example.test', 'x-csrf-token': 'test-csrf', 'content-type': 'application/json' };
const oversizedJson = JSON.stringify({ address: 'alias@example.test', padding: 'x'.repeat(32 * 1024) });

describe('address route authentication and body limits', () => {
  let app: FastifyInstance;
  let authenticate: ReturnType<typeof vi.fn<AuthenticateAddressRequest>>;
  let requestAddress: ReturnType<typeof vi.fn>;
  let provisionFirstMailbox: ReturnType<typeof vi.fn>;
  let parsed: string[];
  beforeEach(async () => {
    app = Fastify({ bodyLimit: 25 * 1024 * 1024 });
    parsed = [];
    app.addHook('preParsing', (request, _reply, payload, done) => { parsed.push(request.url); done(null, payload); });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.send(error);
    });
    // A sibling raw-message endpoint keeps the mail server's larger body budget.
    app.addContentTypeParser('message/rfc822', { parseAs: 'buffer' }, (_request, payload, done) => done(null, payload));
    app.post('/internal/v1/deliveries', async (request) => ({ bytes: (request.body as Buffer).length }));
    authenticate = vi.fn<AuthenticateAddressRequest>(async (request, options) => {
      if (request.headers.cookie !== 'session=valid') throw new ApiError(401, 'authentication_required');
      if (options.mutating && (request.headers.origin !== headers.origin || request.headers['x-csrf-token'] !== headers['x-csrf-token'])) {
        throw new ApiError(403, 'csrf_rejected');
      }
      return actor;
    });
    requestAddress = vi.fn().mockResolvedValue({ id: 'test-request', address: 'alias@example.test', status: 'pending' });
    provisionFirstMailbox = vi.fn().mockResolvedValue({ id: 'personal-mailbox' });
    const service = { requestAddress, provisionFirstMailbox, listAdminMailboxes: vi.fn().mockResolvedValue([]), listForActor: vi.fn().mockResolvedValue({ mailbox: null, addresses: [], requests: [] }) } as unknown as AddressService;
    registerAddressRoutes(app, service, authenticate);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  it('rejects an unauthenticated oversized JSON request before any body parsing', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/address-requests', headers: { 'content-type': 'application/json' }, payload: oversizedJson });
    expect(response.statusCode).toBe(401);
    expect(parsed).toEqual([]);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(requestAddress).not.toHaveBeenCalled();
  });

  it('rejects an authenticated address request above 16 KiB with 413', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/address-requests', headers, payload: oversizedJson });
    expect(response.statusCode).toBe(413);
    expect(parsed).toEqual(['/api/address-requests']);
    expect(requestAddress).not.toHaveBeenCalled();
  });

  it('performs CSRF validation before parsing an oversized mutation body', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/address-requests', headers: { ...headers, 'x-csrf-token': 'wrong' }, payload: oversizedJson });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('csrf_rejected');
    expect(parsed).toEqual([]);
    expect(requestAddress).not.toHaveBeenCalled();
  });

  it('reuses the authenticated principal without authenticating twice in a valid mutation', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/address-requests', headers, payload: { address: 'alias@example.test' } });
    expect(response.statusCode).toBe(200);
    expect(requestAddress).toHaveBeenCalledWith(actor.principalId, { address: 'alias@example.test', action: undefined });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate.mock.calls[0]?.[1]).toEqual({ mutating: true });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('authenticates read routes without incorrectly requiring mutation CSRF', async () => {
    const response = await app.inject({ url: '/api/addresses', headers: { cookie: 'session=valid' } });
    expect(response.statusCode).toBe(200);
    expect(authenticate.mock.calls[0]?.[1]).toEqual({ mutating: false });
    expect(provisionFirstMailbox).toHaveBeenCalledWith(actor.principalId);
  });

  it('retries lazy provisioning on the next addresses read after a transient provisioning failure', async () => {
    provisionFirstMailbox.mockRejectedValueOnce(new ApiError(503, 'provisioning_unavailable'));
    const first = await app.inject({ url: '/api/addresses', headers: { cookie: 'session=valid' } });
    expect(first.statusCode).toBe(503);
    const second = await app.inject({ url: '/api/addresses', headers: { cookie: 'session=valid' } });
    expect(second.statusCode).toBe(200);
    expect(provisionFirstMailbox).toHaveBeenCalledTimes(2);
  });

  it('does not provision a mailbox for an administrator without mailbox.use', async () => {
    authenticate.mockResolvedValue({ ...actor, permissions: new Set(['addresses.manage']) });
    const response = await app.inject({ url: '/api/admin/mailboxes', headers: { cookie: 'session=valid' } });
    expect(response.statusCode).toBe(200);
    expect(provisionFirstMailbox).not.toHaveBeenCalled();
    await app.inject({ url: '/api/addresses', headers: { cookie: 'session=valid' } });
    expect(provisionFirstMailbox).not.toHaveBeenCalled();
  });

  it('does not apply the address hook or limit to the sibling mail ingestion route', async () => {
    const payload = Buffer.alloc(32 * 1024, 97);
    const response = await app.inject({ method: 'POST', url: '/internal/v1/deliveries', headers: { 'content-type': 'message/rfc822' }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().bytes).toBe(payload.length);
    expect(authenticate).not.toHaveBeenCalled();
  });
});
