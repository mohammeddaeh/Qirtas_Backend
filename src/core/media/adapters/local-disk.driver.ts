import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open as openFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  DownloadUrlOptions,
  StorageDriver,
  StorageZone,
  StoredObject,
  UploadTarget,
  UploadTargetOptions,
} from '../ports/storage-driver.js';
import { STORAGE_ZONES } from '../ports/storage-driver.js';
import { isValidStorageKey } from '../storage-keys.js';
import { FILES_BASE_PATH } from '../files-path.js';
import type { UrlSigner } from '../signed-url.js';

/** Thrown by `putStream` when the body is not exactly the size the token granted. */
export class UploadSizeError extends Error {
  constructor(readonly reason: 'too_large' | 'too_small') {
    super(`Upload body is ${reason === 'too_large' ? 'larger' : 'smaller'} than declared`);
  }
}

/**
 * Files in a directory on this machine — `<root>/<zone>/<key>`.
 *
 * Development and tests. **Not for a deployment with more than one server
 * machine** (decided 2026-09-28): a file written here exists on one machine
 * only, and the next request may land on another. `env.ts` refuses it in
 * production.
 *
 * Direct uploads come back to this same process through
 * `PUT /files/uploads/:token` (see `putStream`), so the client contract is the
 * same as the S3 driver's presigned PUT.
 */
export class LocalDiskDriver implements StorageDriver {
  private readonly root: string;

  constructor(
    root: string,
    private readonly signer?: UrlSigner,
  ) {
    this.root = resolve(root);
  }

  async put(zone: StorageZone, key: string, bytes: Buffer): Promise<void> {
    const target = this.pathFor(zone, key);
    await mkdir(dirname(target), { recursive: true });
    // Write-then-rename: a crash or a full disk mid-write leaves a temp file,
    // never a truncated image under the real key that a client would cache.
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, target);
  }

  /**
   * Streams an upload to disk without holding it in memory, refusing a body
   * that is not **exactly** `expectedBytes` — the same rule S3 applies to a
   * presigned PUT with a signed `Content-Length`. Write-then-rename, so a
   * dropped connection leaves no half file under the real key.
   */
  async putStream(
    zone: StorageZone,
    key: string,
    body: Readable,
    expectedBytes: number,
  ): Promise<void> {
    const target = this.pathFor(zone, key);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    let seen = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;
        if (seen > expectedBytes) callback(new UploadSizeError('too_large'));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(body, cap, createWriteStream(temp));
      if (seen !== expectedBytes) throw new UploadSizeError('too_small');
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async open(zone: StorageZone, key: string): Promise<StoredObject | null> {
    const target = this.pathFor(zone, key);
    try {
      const info = await stat(target);
      if (!info.isFile()) return null;
      return { stream: createReadStream(target), size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(zone: StorageZone, key: string): Promise<void> {
    await rm(this.pathFor(zone, key), { force: true });
  }

  async exists(zone: StorageZone, key: string): Promise<boolean> {
    return (await this.size(zone, key)) !== null;
  }

  async size(zone: StorageZone, key: string): Promise<number | null> {
    try {
      const info = await stat(this.pathFor(zone, key));
      return info.isFile() ? info.size : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readHead(zone: StorageZone, key: string, bytes: number): Promise<Buffer | null> {
    let handle;
    try {
      handle = await openFile(this.pathFor(zone, key), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async uploadTarget(
    zone: StorageZone,
    key: string,
    options: UploadTargetOptions,
  ): Promise<UploadTarget> {
    this.pathFor(zone, key);
    const { token, expires } = this.requireSigner().signUpload(
      { zone, key, bytes: options.bytes, contentType: options.contentType },
      options.ttlSeconds,
    );
    return {
      method: 'PUT',
      url: `${FILES_BASE_PATH}/uploads/${token}`,
      headers: { 'Content-Type': options.contentType },
      expires_at: new Date(expires * 1000),
    };
  }

  async downloadUrl(key: string, options: DownloadUrlOptions): Promise<string> {
    this.pathFor('private', key);
    const name = options.filename ?? undefined;
    const { expires, signature } = this.requireSigner().sign(
      'private',
      key,
      options.ttlSeconds,
      new Date(),
      name,
    );
    const query = new URLSearchParams({ expires: String(expires), signature });
    if (name !== undefined) query.set('name', name);
    return `${FILES_BASE_PATH}/private/${key}?${query.toString()}`;
  }

  private requireSigner(): UrlSigner {
    if (!this.signer)
      throw new Error('LocalDiskDriver built without a UrlSigner cannot issue links');
    return this.signer;
  }

  /**
   * Validates twice on purpose: the key grammar alone already forbids `..`, and
   * the containment check catches anything the grammar ever lets through by
   * mistake. A path-traversal bug here would expose every private file.
   */
  private pathFor(zone: StorageZone, key: string): string {
    if (!STORAGE_ZONES.includes(zone)) throw new Error(`Unknown storage zone: ${zone}`);
    if (!isValidStorageKey(key)) throw new Error(`Invalid storage key: ${key}`);
    const zoneRoot = join(this.root, zone);
    const target = resolve(zoneRoot, key);
    if (!target.startsWith(zoneRoot + sep)) throw new Error(`Storage key escapes its zone: ${key}`);
    return target;
  }
}
