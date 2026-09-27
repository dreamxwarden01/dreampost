import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from './errors.js';

export interface ReaderPreferences { autoLoadExternalImages: boolean }
export const DEFAULT_READER_PREFERENCES: Readonly<ReaderPreferences> = Object.freeze({ autoLoadExternalImages: false });
export interface ReaderPreferenceAuth {
  authorizeRequest(request: FastifyRequest, options?: { mutating?: boolean; client?: PoolClient }): Promise<{ principalId: string }>;
}

export async function getReaderPreferences(pool: Pick<Pool, 'query'>, principalId: string): Promise<ReaderPreferences> {
  const { rows } = await pool.query<{ auto_load_external_images: boolean }>('SELECT auto_load_external_images FROM principal_preferences WHERE principal_id = $1', [principalId]);
  return { autoLoadExternalImages: rows[0]?.auto_load_external_images ?? false };
}

/** Register only in SSO mode. The development token is not a person and receives no shared preference row. */
export function registerReaderPreferenceRoutes(app: FastifyInstance, pool: Pool, auth: ReaderPreferenceAuth): void {
  void app.register(async (routes) => {
    const principals = new WeakMap<FastifyRequest, string>();
    routes.addHook('onRoute', (options) => { options.bodyLimit = 4096; });
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const actor = await auth.authorizeRequest(request, { mutating: request.method === 'PATCH' });
      principals.set(request, actor.principalId);
    });
    routes.get('/api/preferences', async (request) => getReaderPreferences(pool, principals.get(request)!));
    routes.patch('/api/preferences', async (request) => {
      const value = request.body;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
        || typeof (value as Record<string, unknown>)['autoLoadExternalImages'] !== 'boolean') throw new ApiError(400, 'invalid_reader_preferences');
      const autoLoadExternalImages = (value as ReaderPreferences).autoLoadExternalImages;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Revalidate the session and admission while the principal lock is held through the write.
        const actor = await auth.authorizeRequest(request, { mutating: true, client });
        await client.query(`INSERT INTO principal_preferences(principal_id,auto_load_external_images) VALUES ($1,$2)
          ON CONFLICT(principal_id) DO UPDATE SET auto_load_external_images = EXCLUDED.auto_load_external_images,updated_at = now()`,
        [actor.principalId, autoLoadExternalImages]);
        await client.query('COMMIT');
        return { autoLoadExternalImages };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  });
}
