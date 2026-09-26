import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBlobStore } from '../src/blob-store.js';

const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dreampost-blobs-'));
  directories.push(path);
  return path;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('durable filesystem blobs', () => {
  it('preserves MIME bytes and publishes one complete file across concurrent retries', async () => {
    const root = await directory();
    const store = new FileBlobStore(root);
    const raw = Buffer.from('Subject: Exact bytes\r\nContent-Transfer-Encoding: binary\r\n\r\n\x00\xff\r\n', 'latin1');
    const sha = digest(raw);
    await Promise.all(Array.from({ length: 8 }, () => store.put(sha, raw)));
    expect(await store.get(sha)).toEqual(raw);
    expect(await readdir(join(root, 'blobs', sha.slice(0, 2)))).toEqual([`${sha}.eml`]);
  });

  it('never acknowledges a corrupted existing blob or overwrites it silently', async () => {
    const root = await directory();
    const store = new FileBlobStore(root);
    const raw = Buffer.from('Subject: Stored\r\n\r\nOriginal body');
    const sha = digest(raw);
    await store.put(sha, raw);
    const path = join(root, 'blobs', sha.slice(0, 2), `${sha}.eml`);
    await writeFile(path, 'corrupted');
    await expect(store.get(sha)).rejects.toThrow('blob_digest_mismatch');
    await expect(store.put(sha, raw)).rejects.toThrow('blob_digest_mismatch');
    expect(await readFile(path, 'utf8')).toBe('corrupted');
  });

  it('fails closed when the storage directory cannot be created', async () => {
    const root = await directory();
    const blockingFile = join(root, 'not-a-directory');
    await writeFile(blockingFile, 'block');
    const store = new FileBlobStore(join(blockingFile, 'mail'));
    const raw = Buffer.from('message');
    await expect(store.put(digest(raw), raw)).rejects.toThrow();
  });

  it('rejects wrong content digests and path traversal', async () => {
    const store = new FileBlobStore(await directory());
    await expect(store.put('a'.repeat(64), Buffer.from('body'))).rejects.toThrow('blob_digest_mismatch');
    await expect(store.get('../../outside')).rejects.toThrow('invalid_blob_digest');
  });
});
