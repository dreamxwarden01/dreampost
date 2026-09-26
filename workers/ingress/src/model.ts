import type { DeliveryMetadata, RoutePolicy } from '@dreampost/protocol';

export type DeliveryState = 'receiving' | 'stored' | 'blocked' | 'delivered_pending_delete' | 'done';

export interface DeliveryRecord {
  deliveryId: string;
  metadata: DeliveryMetadata;
  sha256: string | null;
  state: DeliveryState;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  lastEnqueuedAt: number | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  attempts: number;
  lastError: string | null;
}

export type DeliveryPatch = Partial<Pick<DeliveryRecord,
  'sha256' | 'state' | 'updatedAt' | 'nextAttemptAt' | 'leaseToken' | 'leaseUntil' | 'lastError'>>;

export interface StoredPolicy { policy: RoutePolicy; sha256: string; }

export interface Ledger {
  applyPolicy(policy: RoutePolicy, digest: string, now: number): Promise<'applied' | 'conflict'>;
  getPolicy(address: string): Promise<StoredPolicy | null>;
  admitDynamic(record: DeliveryRecord, address: string): Promise<boolean>;
  insert(record: DeliveryRecord): Promise<void>;
  get(id: string): Promise<DeliveryRecord | null>;
  claim(id: string, state: DeliveryState, token: string, now: number, leaseMs: number): Promise<DeliveryRecord | null>;
  updateOwned(id: string, token: string, state: DeliveryState, patch: DeliveryPatch): Promise<boolean>;
  noteEnqueued(id: string, now: number): Promise<void>;
  purgeDone(before: number, limit: number): Promise<number>;
  due(now: number, limit: number, staleQueueBefore: number): Promise<DeliveryRecord[]>;
}

export interface StoredRaw {
  bytes: Uint8Array;
  metadata: unknown;
  sha256: string | undefined;
}

export interface RawStore {
  put(id: string, bytes: Uint8Array, metadata: DeliveryMetadata, sha256: string): Promise<void>;
  get(id: string): Promise<StoredRaw | null>;
  delete(id: string): Promise<void>;
}

export interface WakeQueue { send(body: { deliveryId: string }): Promise<void>; }
export interface InboundMessage {
  from: string;
  to: string;
  rawSize: number;
  raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
}

export type DeliveryResult = { action: 'ack' } | { action: 'retry'; delaySeconds: number };
