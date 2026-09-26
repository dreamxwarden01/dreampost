import { POLICY_PATH } from '@dreampost/protocol';
import { handlePolicyRequest } from './policies.js';
import { readConfig } from './config.js';
import type { GatewayVariables } from './config.js';
import { Gateway } from './core.js';
import type { InboundMessage } from './model.js';
import { D1Ledger, R2RawStore } from './storage.js';

export interface Env extends GatewayVariables {
  DB: D1Database;
  RAW_MAIL: R2Bucket;
  DELIVERY_QUEUE: Queue<{ deliveryId: string }>;
}

function log(event: string, deliveryId?: string): void {
  // Operational codes and opaque delivery IDs only; no message or credential data.
  console.log(JSON.stringify({ event, ...(deliveryId ? { deliveryId } : {}) }));
}

function gateway(env: Env): Gateway {
  return new Gateway({ ledger: new D1Ledger(env.DB), raw: new R2RawStore(env.RAW_MAIL),
    queue: { send: async (body) => { await env.DELIVERY_QUEUE.send(body); } },
    config: readConfig(env), fetch: globalThis.fetch.bind(globalThis), log });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== POLICY_PATH || (env.ROUTING_MODE ?? 'static') !== 'dynamic') {
      return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    try { return await handlePolicyRequest(request, readConfig(env), new D1Ledger(env.DB)); }
    catch {
      log('policy_control_failed');
      return Response.json({ error: 'policy_temporarily_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    try { await gateway(env).receive(message as InboundMessage); }
    catch {
      log('receipt_failed');
      // Cloud SMTP failure mapping remains a platform test, not a promised 4xx retry.
      throw new Error('Inbound receipt failed; inspect the gateway ledger');
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const worker = gateway(env);
    for (const message of batch.messages) {
      const body = message.body as { deliveryId?: unknown } | null;
      if (!body || typeof body.deliveryId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.deliveryId)) {
        log('invalid_queue_reference');
        message.ack();
        continue;
      }
      try {
        const result = await worker.deliver(body.deliveryId);
        if (result.action === 'ack') message.ack();
        else message.retry({ delaySeconds: result.delaySeconds });
      } catch {
        log('queue_attempt_failed', body.deliveryId);
        message.retry({ delaySeconds: 60 });
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await gateway(env).repair();
  },
} satisfies ExportedHandler<Env>;
