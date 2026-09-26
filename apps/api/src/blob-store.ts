import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { BlobStore } from '@dreampost/protocol';

export interface RawBlobStore extends BlobStore {
  get(sha256: string): Promise<Buffer>;
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    try { await directory.sync(); }
    catch (error) {
      // Some filesystems cannot fsync a directory. Other I/O failures remain fatal.
      if (!hasCode(error, 'EINVAL') && !hasCode(error, 'ENOTSUP')) throw error;
    }
  } finally { await directory.close(); }
}

async function durableDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) {
      await durableDirectory(dirname(path));
      await durableDirectory(path);
      return;
    }
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  await syncDirectory(path);
  await syncDirectory(dirname(path));
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class FileBlobStore implements RawBlobStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  private path(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid_blob_digest');
    return join(this.root, 'blobs', sha256.slice(0, 2), `${sha256}.eml`);
  }

  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    const finalPath = this.path(sha256);
    if (digest(bytes) !== sha256) throw new Error('blob_digest_mismatch');
    const directory = dirname(finalPath);
    await durableDirectory(directory);
    const temporary = join(directory, `.${sha256}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally { await file.close(); }
      try {
        // A hard link publishes the complete file atomically without replacing another writer.
        await link(temporary, finalPath);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        const existing = await this.get(sha256);
        if (existing.length !== bytes.length) throw new Error('blob_size_mismatch');
      }
      await syncDirectory(directory);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async get(sha256: string): Promise<Buffer> {
    const bytes = await readFile(this.path(sha256));
    if (digest(bytes) !== sha256) throw new Error('blob_digest_mismatch');
    return bytes;
  }
}
