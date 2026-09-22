import { env } from '../config/env.js';
import { logger } from '../logger/logger.js';
import { LocalDiskDriver } from './adapters/local-disk.driver.js';
import { setStorageDriver, type StorageDriver } from './ports/storage-driver.js';
import { UrlSigner } from './signed-url.js';

let signer: UrlSigner | undefined;

/**
 * Wires file storage. Called once from `buildApp()`.
 *
 * `STORAGE_DRIVER` picks the adapter; `local` is the only one today. A second
 * adapter (MinIO/S3) is a sibling file and one more branch here — nothing that
 * stores or serves a file changes.
 */
export function configureMedia(override?: StorageDriver): void {
  if (!env.STORAGE_SIGNING_KEY) {
    logger.warn(
      'STORAGE_SIGNING_KEY not set — private file links use a per-process key and stop working on restart.',
    );
  }
  signer = new UrlSigner(env.STORAGE_SIGNING_KEY);

  if (override) return setStorageDriver(override);
  setStorageDriver(new LocalDiskDriver(env.STORAGE_LOCAL_ROOT));
}

export function urlSigner(): UrlSigner {
  if (!signer) throw new Error('Media not configured — call configureMedia() in buildApp()');
  return signer;
}
