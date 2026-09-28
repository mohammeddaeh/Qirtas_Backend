import { env } from '../config/env.js';
import { logger } from '../logger/logger.js';
import { LocalDiskDriver } from './adapters/local-disk.driver.js';
import { S3Driver } from './adapters/s3.driver.js';
import { setStorageDriver, type StorageDriver } from './ports/storage-driver.js';
import { UrlSigner } from './signed-url.js';
import { startDocumentSweep } from './document-sweeper.js';

let signer: UrlSigner | undefined;
let localDriver: LocalDiskDriver | undefined;

/**
 * Wires file storage. Called once from `buildApp()`.
 *
 * `STORAGE_DRIVER` picks the adapter: `local` (a directory, development) or
 * `s3` (any S3-compatible store). Nothing that stores or serves a file knows
 * which one it got.
 */
export function configureMedia(override?: StorageDriver): void {
  if (!env.STORAGE_SIGNING_KEY) {
    logger.warn(
      'STORAGE_SIGNING_KEY not set — private file links use a per-process key and stop working on restart.',
    );
  }
  signer = new UrlSigner(env.STORAGE_SIGNING_KEY);
  localDriver = undefined;

  if (override) {
    if (override instanceof LocalDiskDriver) localDriver = override;
    setStorageDriver(override);
    return;
  }

  if (env.STORAGE_DRIVER === 's3') {
    setStorageDriver(
      new S3Driver({
        bucket: env.S3_BUCKET!,
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        publicEndpoint: env.S3_PUBLIC_ENDPOINT,
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      }),
    );
  } else {
    localDriver = new LocalDiskDriver(env.STORAGE_LOCAL_ROOT, signer);
    setStorageDriver(localDriver);
  }

  // Tests build the app many times; one timer per process is the intent.
  if (env.NODE_ENV !== 'test') startDocumentSweep();
}

export function urlSigner(): UrlSigner {
  if (!signer) throw new Error('Media not configured — call configureMedia() in buildApp()');
  return signer;
}

/**
 * The local driver when it is the configured one, else `null` — the
 * `PUT /files/uploads/:token` route exists only for it. With S3 the client
 * uploads to the bucket and that route answers 404.
 */
export function localUploadDriver(): LocalDiskDriver | null {
  return localDriver ?? null;
}
