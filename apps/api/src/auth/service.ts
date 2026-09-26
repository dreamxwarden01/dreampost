import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../errors.js';
import { hashSecret, readCookies, secretEqual, safeReturnTo } from './cookies.js';
import { OidcClient } from './oidc.js';
import { AUTH_PERMISSIONS, FLOW_COOKIE_PREFIX, SESSION_COOKIE, SECURE_FLOW_COOKIE_PREFIX, SECURE_SESSION_COOKIE, type AuthConfig, type AuthOptions } from './types.js';

export interface Actor {
  principalId: string;
  issuer: string;
  subject: string;
  username: string;
  roleId: number;
  permissions: ReadonlySet<string>;
}
interface PrincipalRow {
  id: string; issuer: string; subject: string; username: string;
  app_role: number | null; access_enabled: boolean; auth_version: string; revoked_token_iat: string; last_identity_iat: string;
}
interface SessionRow {
  token_hash: string; principal_id: string; sso_sid: string; auth_version: string;
  csrf_token: string; id_token_hint: string; expires_at: Date; next_activity_at: Date;
}
interface FlowRow { verifier: string; nonce: string; return_to: string; }
interface Event { id: string; type: string; payload: Record<string, unknown>; }

function text(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
const opaque = () => randomBytes(32).toString('base64url');

export class AuthService {
  readonly oidc: OidcClient;
  readonly idleSeconds: number;
  readonly maxSeconds: number;
  readonly sessionCookieName: string;
  readonly flowCookiePrefix: string;
  readonly flowCookiePath: string;
  private readonly now: () => number;

  constructor(readonly pool: Pool, readonly config: AuthConfig, private readonly options: AuthOptions = {}) {
    this.oidc = new OidcClient(config, options);
    this.sessionCookieName = this.oidc.secureCookies ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
    this.flowCookiePrefix = this.oidc.secureCookies ? SECURE_FLOW_COOKIE_PREFIX : FLOW_COOKIE_PREFIX;
    this.flowCookiePath = this.oidc.secureCookies ? '/' : '/auth';
    this.now = options.now ?? Date.now;
    this.idleSeconds = config.sessionIdleSeconds ?? 12 * 3600;
    this.maxSeconds = config.sessionMaxSeconds ?? 24 * 3600;
    if (!Number.isInteger(this.idleSeconds) || !Number.isInteger(this.maxSeconds)
      || this.idleSeconds < 60 || this.maxSeconds < this.idleSeconds || this.maxSeconds > 365 * 86400) {
      throw new Error('Invalid application session windows');
    }
  }

  registrationMaterial() { return this.oidc.registrationMaterial(); }

  async catalogStatus() {
    const { rows } = await this.pool.query<{ last_catalog_sync: Date | null }>('SELECT last_catalog_sync FROM auth_settings WHERE singleton AND catalog_issuer = $1 AND catalog_client_id = $2', [this.oidc.issuer, this.config.clientId]);
    return { configured: true, syncedAt: rows[0]?.last_catalog_sync?.toISOString() ?? null };
  }

  async publishRoleCatalog(): Promise<void> {
    const [{ rows: roles }, { rows: settings }] = await Promise.all([
      this.pool.query<{ role_id: number; name: string; permission_level: number; is_system: boolean }>('SELECT * FROM auth_roles ORDER BY permission_level, role_id'),
      this.pool.query<{ default_role_id: number }>('SELECT default_role_id FROM auth_settings WHERE singleton'),
    ]);
    if (!settings[0] || !roles.some((role) => role.role_id === settings[0]!.default_role_id)) throw new Error('Invalid local default role');
    await this.oidc.publishRoles({ site_name: this.oidc.clientName, default_role: settings[0].default_role_id,
      roles: roles.map((role) => ({ role_id: role.role_id, name: role.name, level: role.permission_level, is_system: role.is_system })) });
    await this.pool.query('UPDATE auth_settings SET last_catalog_sync = $1, catalog_issuer = $2, catalog_client_id = $3 WHERE singleton', [new Date(this.now()), this.oidc.issuer, this.config.clientId]);
  }

  /** Pass the business transaction client to retain the principal lock through mutation commit. */
  async resolvePrincipal(principalId: string, client?: PoolClient): Promise<Actor> {
    const db = client ?? this.pool;
    const { rows } = await db.query<PrincipalRow>(
      `SELECT p.* FROM principals p WHERE p.id = $1 AND p.issuer = $2${client ? ' FOR UPDATE' : ''}`,
      [principalId, this.oidc.issuer],
    );
    const principal = rows[0];
    if (!principal || !principal.access_enabled || principal.app_role === null) throw new ApiError(403, 'application_access_denied');
    const role = await db.query('SELECT 1 FROM auth_roles WHERE role_id = $1', [principal.app_role]);
    if (!role.rowCount) throw new ApiError(403, 'unknown_application_role');
    const baseline = await db.query<{ permission: string }>('SELECT permission FROM auth_role_permissions WHERE role_id = $1', [principal.app_role]);
    const overrides = await db.query<{ permission: string; effect: string }>('SELECT permission, effect FROM auth_user_permission_overrides WHERE principal_id = $1', [principal.id]);
    const permissions = new Set(baseline.rows.map((row) => row.permission));
    for (const override of overrides.rows) {
      if (override.effect === 'allow') permissions.add(override.permission);
      else permissions.delete(override.permission);
    }
    for (const permission of permissions) {
      if (!(AUTH_PERMISSIONS as readonly string[]).includes(permission)) permissions.delete(permission);
    }
    return { principalId: principal.id, issuer: principal.issuer, subject: principal.subject,
      username: principal.username, roleId: principal.app_role, permissions };
  }

  private async session(request: FastifyRequest, client?: PoolClient): Promise<SessionRow> {
    const token = readCookies(request.headers.cookie)[this.sessionCookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(401, 'authentication_required');
    const { rows } = await (client ?? this.pool).query<SessionRow>(
      `SELECT s.* FROM auth_sessions s JOIN principals p ON p.id = s.principal_id
       WHERE s.token_hash = $1 AND p.issuer = $2 AND s.client_id = $4 AND p.access_enabled AND s.auth_version = p.auth_version
         AND s.expires_at > $3 AND s.idle_expires_at > $3
         AND NOT EXISTS (SELECT 1 FROM auth_revoked_sids r WHERE r.issuer = p.issuer AND r.sid = s.sso_sid)`,
      [hashSecret(token), this.oidc.issuer, new Date(this.now()), this.config.clientId],
    );
    if (!rows[0]) throw new ApiError(401, 'authentication_required');
    return rows[0];
  }

  async authorizeRequest(request: FastifyRequest, options: { mutating?: boolean; client?: PoolClient } = {}): Promise<Actor> {
    const session = await this.session(request, options.client);
    if (options.mutating) {
      if (request.headers.origin !== this.oidc.origin) throw new ApiError(403, 'origin_rejected');
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !secretEqual(csrf, session.csrf_token)) throw new ApiError(403, 'csrf_rejected');
    }
    const actor = await this.resolvePrincipal(session.principal_id, options.client);
    // A transaction caller may have waited for revocation's principal lock.
    const current = await this.session(request, options.client);
    if (current.auth_version !== session.auth_version) throw new ApiError(401, 'authentication_required');
    await (options.client ?? this.pool).query(
      'UPDATE auth_sessions SET last_seen = $2, idle_expires_at = LEAST(expires_at, $3) WHERE token_hash = $1',
      [session.token_hash, new Date(this.now()), new Date(this.now() + this.idleSeconds * 1000)],
    );
    if (!options.client && session.next_activity_at.getTime() <= this.now()) {
      void this.reportActivity(session).catch(() => {});
    }
    return actor;
  }

  private async reportActivity(session: SessionRow): Promise<void> {
    const claimed = await this.pool.query(
      'UPDATE auth_sessions SET next_activity_at = $2 WHERE token_hash = $1 AND next_activity_at <= $3 RETURNING token_hash',
      [session.token_hash, new Date(this.now() + 300_000), new Date(this.now())],
    );
    if (!claimed.rowCount) return;
    const result = await this.oidc.reportActivity(session.sso_sid, this.now());
    if (result === 'invalid') await this.revokeSid(session.sso_sid);
    else if (result === 'unknown') await this.pool.query('UPDATE auth_sessions SET next_activity_at = $2 WHERE token_hash = $1', [session.token_hash, new Date(this.now() + 30_000)]);
  }

  async sessionInfo(request: FastifyRequest) {
    const catalog = await this.catalogStatus();
    try {
      const actor = await this.authorizeRequest(request);
      const session = await this.session(request);
      const profile = await this.pool.query<{ display_name: string; email: string | null; avatar: string | null }>('SELECT display_name, email, avatar FROM principals WHERE id = $1', [actor.principalId]);
      return { actor: { ...actor, permissions: [...actor.permissions] }, csrfToken: session.csrf_token,
        profile: profile.rows[0], accountPortalUrl: this.config.accountPortalUrl ?? null, catalog };
    } catch (error) {
      if (!(error instanceof ApiError) || ![401, 403].includes(error.statusCode)) throw error;
      return { actor: null, csrfToken: null, profile: null, accountPortalUrl: this.config.accountPortalUrl ?? null, catalog };
    }
  }

  async beginLogin(returnTo: unknown) {
    if (!(await this.catalogStatus()).syncedAt) throw new ApiError(503, 'sso_registration_incomplete');
    const state = opaque();
    const secret = opaque();
    const verifier = opaque();
    const nonce = opaque();
    await this.pool.query('DELETE FROM auth_flows WHERE expires_at <= $1', [new Date(this.now())]);
    await this.pool.query('INSERT INTO auth_flows (state, cookie_hash, verifier, nonce, return_to, expires_at, issuer, client_id, redirect_uri) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [state, hashSecret(secret), verifier, nonce, safeReturnTo(returnTo), new Date(this.now() + 600_000), this.oidc.issuer, this.config.clientId, this.oidc.redirectUri]);
    return { state, secret, url: this.oidc.authorizeUrl({ state, nonce, challenge: createHash('sha256').update(verifier).digest('base64url') }) };
  }

  async completeLogin(state: unknown, code: unknown, cookies: Record<string, string>) {
    if (!text(state, 64) || !/^[A-Za-z0-9_-]{43}$/.test(state) || !text(code, 4096)) throw new ApiError(400, 'invalid_login_callback');
    const secret = cookies[`${this.flowCookiePrefix}${state}`];
    if (!secret) throw new ApiError(400, 'invalid_login_state');
    const flowResult = await this.pool.query<FlowRow>(
      'DELETE FROM auth_flows WHERE state = $1 AND cookie_hash = $2 AND expires_at > $3 AND issuer = $4 AND client_id = $5 AND redirect_uri = $6 RETURNING verifier, nonce, return_to',
      [state, hashSecret(secret), new Date(this.now()), this.oidc.issuer, this.config.clientId, this.oidc.redirectUri],
    );
    const flow = flowResult.rows[0];
    if (!flow) throw new ApiError(400, 'invalid_login_state');
    let idToken: string;
    let claims: Awaited<ReturnType<OidcClient['verify']>>;
    try {
      idToken = await this.oidc.exchangeCode(code, flow.verifier);
      claims = await this.oidc.verify(idToken, 'JWT');
    } catch { throw new ApiError(401, 'invalid_identity_response'); }
    if (!text(claims.sub) || claims.nonce !== flow.nonce || !text(claims.preferred_username, 200)
      || !text(claims.sid) || typeof claims.sess_exp !== 'number' || !Number.isSafeInteger(claims.sess_exp)
      || claims.sess_exp * 1000 <= this.now() || !Number.isInteger(claims.app_role)) {
      throw new ApiError(403, 'invalid_identity_claims');
    }
    const roleId = claims.app_role as number;
    const expiresAt = Math.min(claims.sess_exp * 1000, this.now() + this.maxSeconds * 1000);
    const token = opaque();
    const csrfToken = opaque();
    const client = await this.pool.connect();
    let principalId: string;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${this.oidc.issuer}:subject:${claims.sub}`]);
      const role = await client.query('SELECT 1 FROM auth_roles WHERE role_id = $1', [roleId]);
      if (!role.rowCount) throw new ApiError(403, 'unknown_application_role');
      const invalidation = await client.query<{ not_before_iat: string }>('SELECT not_before_iat FROM auth_subject_invalidations WHERE issuer = $1 AND subject = $2', [this.oidc.issuer, claims.sub]);
      if (invalidation.rows[0] && (claims.iat ?? 0) <= Number(invalidation.rows[0].not_before_iat)) throw new ApiError(403, 'stale_identity_response');
      await client.query('INSERT INTO principals (id, issuer, subject) VALUES ($1, $2, $3) ON CONFLICT (issuer, subject) DO NOTHING',
        [randomUUID(), this.oidc.issuer, claims.sub]);
      const principal = (await client.query<PrincipalRow>('SELECT * FROM principals WHERE issuer = $1 AND subject = $2 FOR UPDATE', [this.oidc.issuer, claims.sub])).rows[0]!;
      principalId = principal.id;
      if ((claims.iat ?? 0) <= Number(principal.revoked_token_iat)
        || (claims.iat ?? 0) < Number(principal.last_identity_iat)
        || ((claims.iat ?? 0) === Number(principal.last_identity_iat) && principal.app_role !== roleId)) throw new ApiError(403, 'stale_identity_response');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${this.oidc.issuer}:sid:${claims.sid}`]);
      if ((await client.query('SELECT 1 FROM auth_revoked_sids WHERE issuer = $1 AND sid = $2', [this.oidc.issuer, claims.sid])).rowCount) throw new ApiError(401, 'sso_session_revoked');
      await client.query('UPDATE principals SET username = $2, display_name = $3, email = $4, avatar = $5, app_role = $6, access_enabled = true, profile_version = profile_version + 1, last_identity_iat = $7 WHERE id = $1',
        [principal.id, claims.preferred_username, text(claims.name, 200) ? claims.name : claims.preferred_username,
          text(claims.email) ? claims.email : null, text(claims.picture) ? claims.picture : null, roleId, claims.iat]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }

    const actor = await this.resolvePrincipal(principalId);
    await this.options.onLogin?.(actor);
    const sessionClient = await this.pool.connect();
    try {
      await sessionClient.query('BEGIN');
      const principal = (await sessionClient.query<PrincipalRow>('SELECT * FROM principals WHERE id = $1 FOR UPDATE', [principalId])).rows[0]!;
      if (!principal.access_enabled || principal.app_role !== roleId || (claims.iat ?? 0) <= Number(principal.revoked_token_iat)) throw new ApiError(403, 'application_access_denied');
      await sessionClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${this.oidc.issuer}:sid:${claims.sid}`]);
      if ((await sessionClient.query('SELECT 1 FROM auth_revoked_sids WHERE issuer = $1 AND sid = $2', [this.oidc.issuer, claims.sid])).rowCount) throw new ApiError(401, 'sso_session_revoked');
      await sessionClient.query('DELETE FROM auth_sessions WHERE principal_id = $1 AND sso_sid = $2', [principalId, claims.sid]);
      await sessionClient.query(
        `INSERT INTO auth_sessions (token_hash, principal_id, sso_sid, auth_version, csrf_token, id_token_hint, expires_at, idle_expires_at, next_activity_at, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [hashSecret(token), principalId, claims.sid, principal.auth_version, csrfToken, idToken,
          new Date(expiresAt), new Date(Math.min(expiresAt, this.now() + this.idleSeconds * 1000)), new Date(this.now() + 300_000), this.config.clientId],
      );
      await sessionClient.query('COMMIT');
    } catch (error) { await sessionClient.query('ROLLBACK'); throw error; }
    finally { sessionClient.release(); }
    return { token, csrfToken, expiresAt, persistent: claims.sess_persistent === true, returnTo: flow.return_to };
  }

  private async revokeSid(sid: string, transaction?: PoolClient): Promise<void> {
    const client = transaction ?? await this.pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${this.oidc.issuer}:sid:${sid}`]);
      await client.query('INSERT INTO auth_revoked_sids (issuer, sid) VALUES ($1, $2) ON CONFLICT DO NOTHING', [this.oidc.issuer, sid]);
      await client.query('DELETE FROM auth_sessions s USING principals p WHERE s.principal_id = p.id AND p.issuer = $1 AND s.sso_sid = $2', [this.oidc.issuer, sid]);
      if (!transaction) await client.query('COMMIT');
    } catch (error) { if (!transaction) await client.query('ROLLBACK'); throw error; }
    finally { if (!transaction) client.release(); }
  }

  async logout(request: FastifyRequest): Promise<string> {
    await this.authorizeRequest(request, { mutating: true });
    const session = await this.session(request);
    await this.revokeSid(session.sso_sid);
    return this.oidc.logoutUrl(session.id_token_hint);
  }

  async acceptEvents(token: string): Promise<void> {
    let envelope: Awaited<ReturnType<OidcClient['verify']>>;
    try { envelope = await this.oidc.verify(token, 'events+jwt'); }
    catch { throw new ApiError(401, 'invalid_event_token'); }
    if (!Array.isArray(envelope.events) || !envelope.events.length || envelope.events.length > 100) throw new ApiError(400, 'invalid_events');
    const events: Event[] = envelope.events.map((event: unknown) => {
      if (!event || typeof event !== 'object') throw new ApiError(400, 'invalid_event');
      const value = event as Record<string, unknown>;
      if (!text(value.id, 128) || !text(value.type, 128) || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) throw new ApiError(400, 'invalid_event');
      return { id: value.id, type: value.type, payload: value.payload as Record<string, unknown> };
    });
    // Validate the full batch before any event commits or claims its dedupe ID.
    for (const event of events) this.validateEvent(event);
    for (const event of events) await this.applyEvent(event, envelope.iat ?? 0);
  }

  private validateEvent(event: Event): void {
    const payload = event.payload;
    if (event.type === 'logout') {
      if (!text(payload.sid)) throw new ApiError(400, 'invalid_logout_event');
    } else if (event.type === 'account.roles_change' || event.type === 'account.status_change') {
      if (!text(payload.sub)) throw new ApiError(400, 'invalid_account_event');
      if (event.type === 'account.roles_change' && payload.role_id !== null
        && (!Number.isInteger(payload.role_id) || Number(payload.role_id) < -2147483648 || Number(payload.role_id) > 2147483647)) {
        throw new ApiError(400, 'invalid_role_event');
      }
    } else if (event.type === 'account.profile_change') {
      if (!text(payload.sub) || (payload.avatar !== null && !text(payload.avatar))) throw new ApiError(400, 'invalid_profile_event');
    }
  }

  private async applyEvent(event: Event, issuedAt: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const fresh = await client.query('INSERT INTO auth_events (issuer, event_id, event_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id', [this.oidc.issuer, event.id, event.type]);
      if (!fresh.rowCount) { await client.query('COMMIT'); return; }
      const payload = event.payload;
      if (event.type === 'logout') {
        await this.revokeSid(payload.sid as string, client);
      } else if (event.type === 'account.roles_change' || event.type === 'account.status_change') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${this.oidc.issuer}:subject:${payload.sub}`]);
        const cutoff = Math.max(issuedAt, Math.floor(this.now() / 1000));
        await client.query(`INSERT INTO auth_subject_invalidations (issuer, subject, not_before_iat) VALUES ($1, $2, $3)
          ON CONFLICT (issuer, subject) DO UPDATE SET not_before_iat = GREATEST(auth_subject_invalidations.not_before_iat, EXCLUDED.not_before_iat)`,
        [this.oidc.issuer, payload.sub, cutoff]);
        const known = event.type === 'account.roles_change' && Number.isInteger(payload.role_id)
          ? (await client.query('SELECT role_id FROM auth_roles WHERE role_id = $1', [payload.role_id])).rows[0]?.role_id as number | undefined : undefined;
        const { rows } = await client.query<{ id: string }>(
          `UPDATE principals SET access_enabled = false, app_role = $3, auth_version = auth_version + 1,
           revoked_token_iat = GREATEST(revoked_token_iat, $4) WHERE issuer = $1 AND subject = $2 RETURNING id`,
          [this.oidc.issuer, payload.sub, known ?? null, cutoff],
        );
        for (const row of rows) await client.query('DELETE FROM auth_sessions WHERE principal_id = $1', [row.id]);
      } else if (event.type === 'account.profile_change') {
        await client.query('UPDATE principals SET avatar = $3, profile_version = profile_version + 1 WHERE issuer = $1 AND subject = $2',
          [this.oidc.issuer, payload.sub, payload.avatar]);
      } else if (event.type === 'roles.sync_request') {
        // Publication is explicit and must succeed before the request is marked processed.
        await this.publishRoleCatalog();
      }
      // Unknown types are acknowledged for ecosystem forward compatibility.
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
