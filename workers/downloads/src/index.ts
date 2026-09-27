import {
  MAX_DOWNLOAD_CONTROL_BYTES, attachmentObjectKey, createAttachmentUploadResponseHeaders, createDownloadControlHeaders,
  isDownloadId, isDownloadSecret, sha256Hex, verifyAttachmentUploadHeaders, verifyDownloadControlResponse,
  type AttachmentObjectDescriptor, type DownloadControlRequest, type DownloadControlReply,
} from '@dreampost/protocol';
import { admitRequestStart } from './admission.js';
import { readConfig, type Config, type Variables } from './config.js';
import { HttpError, challengePrefix, cookie, cookies, cors, disposition, etagMatches, jsonBody, parseRange,
  randomSecret, readBounded, requireSecret, securityHeaders, sessionPrefix } from './http.js';
export interface Env extends Variables { ATTACHMENTS: R2Bucket; REQUEST_START_LIMITER?: RateLimit }
export interface Dependencies { fetch?: typeof fetch; now?: () => number }
const idPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const bytePath = new RegExp(`^/sessions/(${idPattern})/transfers/(${idPattern})$`);
const uploadPath = new RegExp(`^/internal/v1/objects/(${idPattern})$`);
function cookieCount(values: Map<string, string>, prefix: string): number { return [...values.keys()].filter(name => name.startsWith(prefix)).length; }
function matchesObject(object: R2Object, expected: Pick<AttachmentObjectDescriptor, 'sha256' | 'sizeBytes'>, objectKey: string): boolean {
  const checksum = object.checksums?.sha256;
  const hex = checksum ? [...new Uint8Array(checksum)].map(byte => byte.toString(16).padStart(2, '0')).join('') : null;
  return object.key === objectKey && object.size === expected.sizeBytes && hex === expected.sha256
    && object.customMetadata?.attachmentId === objectKey.split('/')[1] && object.customMetadata?.sha256 === expected.sha256;
}
export function createDownloadWorker(deps: Dependencies = {}) {
  const fetcher = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = deps.now ?? Date.now;
  async function control(request: DownloadControlRequest, config: Config): Promise<DownloadControlReply> {
    const headers = await createDownloadControlHeaders(request, config.key, { nowMs: now() });
    let response: Response;
    try { response = await fetcher(config.backendUrl, { method: 'POST', headers, body: JSON.stringify(request), redirect: 'manual', signal: AbortSignal.timeout(10_000) }); }
    catch { throw new HttpError(503, 'authorization_unavailable'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new HttpError(503, 'authorization_unavailable'); }
    let reply: DownloadControlReply;
    try { reply = await verifyDownloadControlResponse(response.headers, await readBounded(response.body, MAX_DOWNLOAD_CONTROL_BYTES), config.keys,
      { requestNonce: headers['x-dreampost-download-nonce'], status: response.status, nowMs: now() }); }
    catch { throw new HttpError(503, 'authorization_unavailable'); }
    if (reply.op === 'error') throw new HttpError([400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 503, reply.error, response.status === 401);
    if (reply.op !== request.op) throw new HttpError(503, 'authorization_unavailable');
    return reply;
  }
  async function pruneSessions(values: Map<string, string>, config: Config): Promise<string[]> {
    const prefix = sessionPrefix(config.secure);
    const entries = [...values.entries()].filter(([name]) => name.startsWith(prefix));
    if (entries.length > 32) throw new HttpError(429, 'download_session_limit');
    const clearNames: string[] = [];
    const sessions: Array<{ sessionId: string; secretHash: string }> = [];
    for (const [name, value] of entries) {
      if (!isDownloadSecret(value)) { clearNames.push(name); continue; }
      sessions.push({ sessionId: name.slice(prefix.length), secretHash: await sha256Hex(new TextEncoder().encode(value)) });
    }
    if (sessions.length) {
      const result = await control({ version: 1, op: 'prune', sessions }, config);
      const requested = new Set(sessions.map(value => value.sessionId));
      if (result.op !== 'prune' || result.expiredSessionIds.some(id => !requested.has(id))) throw new HttpError(503, 'authorization_unavailable');
      for (const id of result.expiredSessionIds) clearNames.push(`${prefix}${id}`);
    }
    // Commit cookie changes only after the complete signed prune result was checked.
    // A temporary callback failure must not clear valid or malformed session cookies.
    for (const name of clearNames) values.delete(name);
    return clearNames;
  }
  async function upload(request: Request, env: Env, config: Config, attachmentId: string): Promise<Response> {
    let verified: Awaited<ReturnType<typeof verifyAttachmentUploadHeaders>>;
    try { verified = await verifyAttachmentUploadHeaders(request.headers, attachmentId, config.keys, { nowMs: now() }); }
    catch { throw new HttpError(401, 'invalid_upload_authorization'); }
    const { descriptor } = verified; const objectKey = attachmentObjectKey(attachmentId, descriptor.sha256);
    const fixed = new FixedLengthStream(descriptor.sizeBytes); const abort = new AbortController();
    const source = request.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const pump = source.pipeTo(fixed.writable, { signal: abort.signal }); void pump.catch(() => {});
    let object: R2Object | null;
    try {
      object = await env.ATTACHMENTS.put(objectKey, fixed.readable, { onlyIf: { etagDoesNotMatch: '*' },
        sha256: Uint8Array.from(descriptor.sha256.match(/../g)!, hex => Number.parseInt(hex, 16)).buffer,
        customMetadata: { attachmentId, sha256: descriptor.sha256 }, httpMetadata: { contentType: 'application/octet-stream' } });
      if (object) await pump;
      else { await fixed.readable.cancel().catch(() => {}); abort.abort(); await pump.catch(() => {}); object = await env.ATTACHMENTS.head(objectKey); }
    } catch { await fixed.readable.cancel().catch(() => {}); abort.abort(); await pump.catch(() => {}); throw new HttpError(422, 'upload_failed'); }
    if (!object || !matchesObject(object, descriptor, objectKey)) throw new HttpError(409, 'object_conflict');
    const ack = { version: 1 as const, status: 'stored' as const, ...descriptor, objectKey };
    const headers = securityHeaders();
    for (const [name, value] of Object.entries(await createAttachmentUploadResponseHeaders(ack, config.key, { requestNonce: verified.nonce, nowMs: now() }))) headers.set(name, value);
    return new Response(JSON.stringify(ack), { headers });
  }
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      let config: Config;
      try { config = readConfig(env); } catch { return Response.json({ error: 'download_unavailable' }, { status: 503, headers: securityHeaders() }); }
      const url = new URL(request.url); const bytes = bytePath.exec(url.pathname); const object = uploadPath.exec(url.pathname);
      const bootstrap = ['/bootstrap/challenge', '/bootstrap/redeem'].includes(url.pathname);
      let targetSessionCookie: string | undefined;
      const clearedSessionCookies: string[] = [];
      try {
        if (url.origin !== config.downloadOrigin || url.search || url.hash) throw new HttpError(404, 'not_found');
        if (request.method === 'OPTIONS') {
          if (!bootstrap && !bytes) throw new HttpError(404, 'not_found');
          if (request.headers.get('origin') !== config.appOrigin) throw new HttpError(403, 'origin_not_allowed');
          const methods = bootstrap ? ['POST'] : ['GET', 'HEAD'];
          const allowed = bootstrap ? ['content-type'] : ['range', 'if-range', 'if-match', 'if-none-match'];
          const method = request.headers.get('access-control-request-method');
          const asked = (request.headers.get('access-control-request-headers') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
          if (!method || !methods.includes(method) || asked.some(value => !allowed.includes(value))) throw new HttpError(403, 'preflight_not_allowed');
          const headers = securityHeaders(); cors(headers, request, config); headers.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
          headers.set('Access-Control-Allow-Methods', methods.join(', ')); headers.set('Access-Control-Allow-Headers', allowed.join(', '));
          return new Response(null, { status: 204, headers });
        }
        if (object || bootstrap || bytes) await admitRequestStart(request, env.REQUEST_START_LIMITER, config);
        if (object) { if (request.method !== 'PUT') throw new HttpError(405, 'method_not_allowed'); return await upload(request, env, config, object[1]!); }
        if (bootstrap) {
          if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
          if (request.headers.get('origin') !== config.appOrigin) throw new HttpError(403, 'origin_not_allowed');
          const challenge = url.pathname === '/bootstrap/challenge'; const body = await jsonBody(request, challenge ? ['flowId'] : ['flowId', 'ticket']);
          if (!isDownloadId(body.flowId) || (!challenge && !isDownloadSecret(body.ticket))) throw new HttpError(400, 'invalid_request');
          const values = cookies(request, config.secure), challengeName = `${challengePrefix(config.secure)}${body.flowId}`;
          if (challenge) clearedSessionCookies.push(...await pruneSessions(values, config));
          if (cookieCount(values, sessionPrefix(config.secure)) >= config.maxSessions) throw new HttpError(429, 'download_session_limit');
          const headers = securityHeaders(); cors(headers, request, config); headers.set('Content-Type', 'application/json');
          for (const name of clearedSessionCookies) headers.append('Set-Cookie', cookie(name, '', 0, config, now()));
          if (challenge) {
            if (!values.has(challengeName) && cookieCount(values, challengePrefix(config.secure)) >= config.maxChallenges) throw new HttpError(429, 'bootstrap_limit');
            const secret = randomSecret(); headers.append('Set-Cookie', cookie(challengeName, secret, now() + 120_000, config, now()));
            return new Response(JSON.stringify({ flowId: body.flowId, challengeHash: await sha256Hex(new TextEncoder().encode(secret)) }), { headers });
          }
          const challengeSecret = requireSecret(values, challengeName), sessionSecret = randomSecret();
          const result = await control({ version: 1, op: 'redeem', flowId: body.flowId, ticket: body.ticket as string,
            challengeHash: await sha256Hex(new TextEncoder().encode(challengeSecret)), secretHash: await sha256Hex(new TextEncoder().encode(sessionSecret)) }, config);
          if (result.op !== 'redeem' || result.expiresAt <= now()) throw new HttpError(401, 'bootstrap_expired');
          const sessionName = `${sessionPrefix(config.secure)}${result.sessionId}`;
          if (values.has(sessionName)) throw new HttpError(409, 'download_session_conflict');
          headers.append('Set-Cookie', cookie(sessionName, sessionSecret, result.expiresAt, config, now()));
          headers.append('Set-Cookie', cookie(challengeName, '', 0, config, now()));
          return new Response(JSON.stringify({ sessionId: result.sessionId, transferId: result.transferId, purpose: result.purpose, expiresAt: result.expiresAt, url: `${config.downloadOrigin}/sessions/${result.sessionId}/transfers/${result.transferId}` }), { headers });
        }
        if (!bytes) throw new HttpError(404, 'not_found');
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
        const origin = request.headers.get('origin');
        if (origin !== null && origin !== config.appOrigin && origin !== config.downloadOrigin) throw new HttpError(403, 'origin_not_allowed');
        if (request.headers.get('sec-fetch-site') === 'cross-site' && request.headers.get('sec-fetch-mode') !== 'navigate') throw new HttpError(403, 'cross_site_read_blocked');
        const sessionId = bytes[1]!, transferId = bytes[2]!; targetSessionCookie = `${sessionPrefix(config.secure)}${sessionId}`;
        const secret = requireSecret(cookies(request, config.secure), targetSessionCookie);
        const result = await control({ version: 1, op: 'authorize', sessionId, transferId,
          secretHash: await sha256Hex(new TextEncoder().encode(secret)), method: request.method, requestOrigin: origin }, config);
        if (result.op !== 'authorize' || result.sessionId !== sessionId || result.transferId !== transferId) throw new HttpError(503, 'authorization_unavailable');
        if (result.purpose === 'preview' && origin !== config.appOrigin) throw new HttpError(403, 'preview_origin_required');
        if (result.expiresAt <= now() || result.sessionExpiresAt <= now()) throw new HttpError(401, 'read_grant_expired');
        const metadata = await env.ATTACHMENTS.head(result.objectKey);
        if (result.expiresAt <= now() || result.sessionExpiresAt <= now()) throw new HttpError(401, 'read_grant_expired');
        if (!metadata) throw new HttpError(404, 'object_not_found');
        if (!matchesObject(metadata, result, result.objectKey)) throw new HttpError(503, 'object_integrity_failed');
        const etag = `"sha256-${result.sha256}"`; const headers = securityHeaders(); cors(headers, request, config);
        headers.set('Content-Type', ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain'].includes(result.mimeType) ? result.mimeType : 'application/octet-stream'); headers.set('Content-Disposition', disposition(result.filename));
        headers.set('Accept-Ranges', 'bytes'); headers.set('ETag', etag);
        headers.set('X-DreamPost-Session-Expires-At', String(result.sessionExpiresAt));
        headers.append('Set-Cookie', cookie(targetSessionCookie, secret, result.sessionExpiresAt, config, now()));
        if (request.headers.has('if-match') && !etagMatches(request.headers.get('if-match'), etag, false)) throw new HttpError(412, 'precondition_failed');
        if (etagMatches(request.headers.get('if-none-match'), etag, true)) return new Response(null, { status: 304, headers });
        const ifRange = request.headers.get('if-range');
        let range: { offset: number; length: number } | undefined;
        try { range = request.method === 'GET' && (ifRange === null || ifRange === etag) ? parseRange(request.headers.get('range'), result.sizeBytes) : undefined; }
        catch (error) { if (error instanceof HttpError && error.status === 416) { headers.set('Content-Range', `bytes */${result.sizeBytes}`); return new Response(null, { status: 416, headers }); } throw error; }
        const length = range?.length ?? result.sizeBytes; headers.set('Content-Length', String(length));
        if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${result.sizeBytes}`);
        if (result.expiresAt <= now()) throw new HttpError(401, 'read_grant_expired');
        if (request.method === 'HEAD') return new Response(null, { headers });
        const body = await env.ATTACHMENTS.get(result.objectKey, range ? { range } : undefined);
        if (!body || !('body' in body)) throw new HttpError(404, 'object_not_found');
        if (!matchesObject(body, result, result.objectKey) || result.expiresAt <= now()) { await body.body.cancel(); throw new HttpError(503, 'read_not_admitted'); }
        return new Response(body.body, { status: range ? 206 : 200, headers });
      } catch (error) {
        const failure = error instanceof HttpError ? error : new HttpError(503, 'download_unavailable');
        const headers = securityHeaders(); cors(headers, request, config); headers.set('Content-Type', 'application/json');
        for (const name of clearedSessionCookies) headers.append('Set-Cookie', cookie(name, '', 0, config, now()));
        if (failure.code === 'request_rate_limited') headers.set('Retry-After', '60');
        if (failure.clearSession && targetSessionCookie) headers.append('Set-Cookie', cookie(targetSessionCookie, '', 0, config, now()));
        return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: failure.code }), { status: failure.status, headers });
      }
    },
  };
}
export default createDownloadWorker();
