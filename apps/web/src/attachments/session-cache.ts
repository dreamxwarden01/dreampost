import { ApiError } from '../api';

export type DownloadPurpose = 'download' | 'preview';
export interface SessionLocator { sessionId: string; purpose: DownloadPurpose; expiresAt: number }
const PREFIX = 'dreampost:attachment-session:v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let activeNamespace = '';
let persistenceFailed = false;
const memory = new Map<DownloadPurpose, SessionLocator>();
const key = (namespace: string, purpose: DownloadPurpose) => `${PREFIX}${encodeURIComponent(namespace)}:${purpose}`;
function storage(): Storage | null { if (persistenceFailed) return null; try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }
function removeKey(name: string) { try { storage()?.removeItem(name); } catch { /* Cookie authorization never depends on localStorage. */ } }

export function clearSessionLocators(): void {
  activeNamespace = ''; memory.clear(); persistenceFailed = false;
  try {
    const store = storage(); if (!store) return;
    for (let index = store.length - 1; index >= 0; index--) { const name = store.key(index); if (name?.startsWith(PREFIX)) store.removeItem(name); }
  } catch { /* Storage-blocked browsers keep only bounded page memory. */ }
}

export async function selectSessionNamespace(downloadOrigin: string, source: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)); signal.throwIfAborted();
  const namespace = `${downloadOrigin}:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  if (activeNamespace !== namespace) {
    memory.clear(); activeNamespace = namespace;
    try {
      const store = storage();
      if (store) for (let index = store.length - 1; index >= 0; index--) {
        const name = store.key(index);
        if (name?.startsWith(PREFIX) && name !== key(namespace, 'download') && name !== key(namespace, 'preview')) store.removeItem(name);
      }
    } catch { /* Keep working without persistent locator reuse if storage is unavailable. */ }
  }
  return namespace;
}

export function getSessionLocator(namespace: string, purpose: DownloadPurpose): SessionLocator | undefined {
  if (namespace !== activeNamespace) return undefined;
  let value: SessionLocator | undefined;
  try {
    const store = storage();
    if (store) {
      const encoded = store.getItem(key(namespace, purpose));
      if (encoded !== null) {
        if (encoded.length > 256) throw new Error('Invalid locator');
        const item: unknown = JSON.parse(encoded);
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3
          || !('sessionId' in item) || typeof item.sessionId !== 'string' || !UUID.test(item.sessionId)
          || !('purpose' in item) || item.purpose !== purpose
          || !('expiresAt' in item) || typeof item.expiresAt !== 'number' || !Number.isSafeInteger(item.expiresAt)) throw new Error('Invalid locator');
        value = item as SessionLocator;
      }
      // Read under the cross-tab lock rather than preferring a stale in-memory locator.
    } else value = memory.get(purpose);
  } catch { removeKey(key(namespace, purpose)); value = memory.get(purpose); }
  if (!value || value.expiresAt <= Date.now()) { memory.delete(purpose); removeKey(key(namespace, purpose)); return undefined; }
  memory.set(purpose, value); return value;
}

export function saveSessionLocator(namespace: string, value: SessionLocator): void {
  if (namespace !== activeNamespace) return;
  const locator = { sessionId: value.sessionId, purpose: value.purpose, expiresAt: value.expiresAt };
  memory.set(value.purpose, locator);
  try { storage()?.setItem(key(namespace, value.purpose), JSON.stringify(locator)); } catch { persistenceFailed = true; /* Retain only page memory when storage writes are blocked. */ }
}

/** A late failure from an old preview must not invalidate a newer source, purpose, or replacement session. */
export function invalidateSessionLocator(namespace: string, purpose: DownloadPurpose, sessionId: string): void {
  if (namespace !== activeNamespace) return;
  const current = getSessionLocator(namespace, purpose);
  if (current?.sessionId !== sessionId) return;
  memory.delete(purpose); removeKey(key(namespace, purpose));
}

interface Waiter { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }
const pageLocks = new Map<string, { active: boolean; waiting: Waiter[] }>();
async function pageLock(name: string, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  let entry = pageLocks.get(name); if (!entry) { entry = { active: false, waiting: [] }; pageLocks.set(name, entry); }
  const state = entry;
  if (state.waiting.length >= 8) throw new ApiError('Too many attachment requests are waiting. Try again shortly.', 429);
  return new Promise((resolve, reject) => {
    const release = () => {
      const next = state.waiting.shift();
      if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(release); }
      else { state.active = false; pageLocks.delete(name); }
    };
    if (!state.active) { state.active = true; resolve(release); return; }
    const waiter: Waiter = { signal, resolve, reject, abort: () => {
      const index = state.waiting.indexOf(waiter); if (index >= 0) state.waiting.splice(index, 1);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    } };
    state.waiting.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
  });
}

export async function withSessionLock<T>(namespace: string, purpose: DownloadPurpose, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  const name = `${PREFIX}${namespace}:${purpose}`;
  // The page queue also bounds callers on browsers with Web Locks. Web Locks serialize first use across tabs.
  const release = await pageLock(name, signal);
  try {
    signal.throwIfAborted();
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (locks?.request) return await locks.request(name, { mode: 'exclusive', signal }, async () => { signal.throwIfAborted(); return action(); });
    return await action();
  } finally { release(); }
}
