import { createHash } from 'node:crypto';
import { mkdir, open, readFile, link, unlink, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AttachmentStagingStore } from './types.js';

function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, 'r');
  try { try { await file.sync(); } catch (error) { if (!hasCode(error, 'EINVAL') && !hasCode(error, 'ENOTSUP')) throw error; } }
  finally { await file.close(); }
}
async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (hasCode(error, 'ENOENT')) { await ensureDirectory(dirname(path)); await ensureDirectory(path); return; } if (!hasCode(error, 'EEXIST')) throw error; }
  await syncDirectory(path); await syncDirectory(dirname(path));
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export class AttachmentStorageError extends Error { constructor(readonly code: string) { super(code); this.name = 'AttachmentStorageError'; } }

/** Local staging is independent of the retained raw-MIME store and contains no user-supplied path names. */
export class FileAttachmentStagingStore implements AttachmentStagingStore {
  readonly root: string;
  readonly minimumFreeBytes: number;
  constructor(root: string, options: { minimumFreeBytes?: number } = {}) {
    this.root = resolve(root); this.minimumFreeBytes = options.minimumFreeBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.minimumFreeBytes) || this.minimumFreeBytes < 0) throw new Error('invalid_attachment_disk_headroom');
  }
  private path(id: string, sha256: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid_attachment_storage_identity');
    return join(this.root, id.slice(0, 2), id, `${sha256}.bin`);
  }
  async put(id: string, sha256: string, bytes: Uint8Array): Promise<void> {
    if (digest(bytes) !== sha256) throw new AttachmentStorageError('attachment_digest_mismatch');
    const finalPath = this.path(id, sha256);
    try { const existing = await this.get(id, sha256); if (existing.length !== bytes.length) throw new Error('attachment_size_mismatch'); return; }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    const directory = dirname(finalPath);
    await ensureDirectory(directory);
    const filesystem = await statfs(directory);
    if (filesystem.bavail * filesystem.bsize < bytes.byteLength + this.minimumFreeBytes) throw new AttachmentStorageError('attachment_staging_disk_pressure');
    // One deterministic partial path bounds crash leftovers. The service holds the object row lock here.
    const temporary = `${finalPath}.partial`;
    await unlink(temporary).catch(error => { if (!hasCode(error, 'ENOENT')) throw error; });
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, finalPath); }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; const existing = await this.get(id, sha256); if (existing.length !== bytes.length) throw new Error('attachment_size_mismatch'); }
      await syncDirectory(directory);
    } finally { await unlink(temporary).catch(error => { if (!hasCode(error, 'ENOENT')) throw error; }); }
  }
  async get(id: string, sha256: string): Promise<Buffer> {
    const bytes = await readFile(this.path(id, sha256));
    if (digest(bytes) !== sha256) throw new AttachmentStorageError('attachment_digest_mismatch');
    return bytes;
  }
  async remove(id: string, sha256: string): Promise<void> {
    const path = this.path(id, sha256);
    try { await unlink(path); await syncDirectory(dirname(path)); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    // A crash after publication can leave the same inode under its temporary name.
    try { await unlink(`${path}.partial`); await syncDirectory(dirname(path)); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
}
