import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import type { AddressActor } from './types.js';
import type { AddressService } from './service.js';

export type AuthenticateAddressRequest = (request: FastifyRequest, options: { mutating: boolean }) => Promise<AddressActor>;
function body(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new ApiError(400, 'invalid_body');
  return request.body as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_body');
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ApiError(400, 'invalid_body');
  return value;
}

/** Authentication must validate the session and CSRF/origin requirements for mutations. */
export function registerAddressRoutes(app: FastifyInstance, service: AddressService, authenticate: AuthenticateAddressRequest): void {
  void app.register(async (routes) => {
    const principals = new WeakMap<FastifyRequest, AddressActor>();
    routes.addHook('onRoute', (options) => { options.bodyLimit = 16 * 1024; });
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const principal = await authenticate(request, { mutating: !['GET', 'HEAD', 'OPTIONS'].includes(request.method) });
      principals.set(request, principal);
    });
    const actor = (request: FastifyRequest): string => {
      const principalId = principals.get(request)?.principalId;
      if (!principalId) throw new ApiError(401, 'authentication_required');
      return principalId;
    };
    routes.get('/api/addresses', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const principalId = actor(request);
      if (principals.get(request)?.permissions.has('mailbox.use')) await service.provisionFirstMailbox(principalId);
      return service.listForActor(principalId);
    });
    routes.get('/api/sending-identities', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { identities: await service.listSendingIdentities(await actor(request)) };
    });
    routes.post('/api/address-requests', async (request) => {
      const principalId = await actor(request);
      const input = body(request);
      const action = input['action'];
      if (action !== undefined && action !== 'add' && action !== 'reactivate') throw new ApiError(400, 'invalid_request_action');
      return { request: await service.requestAddress(principalId, { address: text(input['address']), action }) };
    });
    routes.get('/api/admin/addresses', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { addresses: await service.listAdminAddresses(await actor(request)) };
    });
    routes.get('/api/admin/mailboxes', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { mailboxes: await service.listAdminMailboxes(await actor(request)) };
    });
    routes.get('/api/admin/address-requests', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { requests: await service.listRequests(await actor(request)) };
    });
    routes.post<{ Params: { requestId: string } }>('/api/admin/address-requests/:requestId/approve', async (request) => ({ allocation: await service.approveRequest(await actor(request), request.params.requestId) }));
    routes.post<{ Params: { requestId: string } }>('/api/admin/address-requests/:requestId/reject', async (request) => {
      const principalId = await actor(request);
      const input = body(request);
      await service.rejectRequest(principalId, request.params.requestId, input['reason'] === undefined ? '' : text(input['reason']));
      return { ok: true };
    });
    for (const [path, mode] of [['', 'manual'], ['/reactivate', 'reactivated'], ['/reassign', 'reassigned']] as const) {
      routes.post(`/api/admin/addresses${path}`, async (request) => {
        const principalId = await actor(request);
        const input = body(request);
        return { allocation: await service.addAddress(principalId, { address: text(input['address']), mailboxId: text(input['mailboxId']) }, mode) };
      });
    }
    routes.post<{ Params: { allocationId: string } }>('/api/admin/addresses/:allocationId/remove', async (request) => {
      await service.removeAddress(await actor(request), request.params.allocationId);
      return { ok: true };
    });
    for (const [path, kind] of [['/api/addresses/:allocationId/owner-pause', 'owner'], ['/api/admin/addresses/:allocationId/admin-pause', 'admin']] as const) {
      routes.put<{ Params: { allocationId: string } }>(path, async (request) => {
        const principalId = await actor(request);
        const input = body(request);
        await service.setPause(principalId, request.params.allocationId, kind, flag(input['paused']), input['reason'] === undefined ? '' : text(input['reason']));
        return { ok: true };
      });
    }
    routes.put<{ Params: { allocationId: string } }>('/api/admin/addresses/:allocationId/receive-only', async (request) => {
      const principalId = await actor(request);
      await service.setReceiveOnly(principalId, request.params.allocationId, flag(body(request)['receiveOnly']));
      return { ok: true };
    });
    routes.put<{ Params: { allocationId: string } }>('/api/admin/addresses/:allocationId/send-grants', async (request) => {
      const principalId = await actor(request);
      const input = body(request);
      await service.setSendGrant(principalId, request.params.allocationId, text(input['principalId']), flag(input['enabled']));
      return { ok: true };
    });
  });
}
