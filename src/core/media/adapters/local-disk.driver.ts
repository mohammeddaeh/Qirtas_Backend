import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StorageDriver, StorageZone, StoredObject } from '../ports/storage-driver.js';
import { STORAGE_ZONES } from '../ports/storage-driver.js';
import { isValidStorageKey } from '../storage-keys.js';

/**
 * Files in a directory on this machine — `<root>/<zone>/<key>`.
 *
 * Today's driver (development runs on a laptop with a local server). It is a
 * real implementation, not a stub: the same code serves a single-server
 * deployment, as long as `<root>` is backed up.
 */
export class LocalDiskDriver implements StorageDriver {
  private readonly root: string;

  constructor(root: string) {
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
    try {
      return (await stat(this.pathFor(zone, key))).isFile();
    } catch {
      return false;
    }
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
