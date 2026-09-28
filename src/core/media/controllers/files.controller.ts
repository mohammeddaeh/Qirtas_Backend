import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { extname } from 'node:path';
import {
  BusinessError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
} from '../../http/api-error.js';
import { storageDriver, type StorageZone } from '../ports/storage-driver.js';
import { isValidStorageKey } from '../storage-keys.js';
import { localUploadDriver, urlSigner } from '../composition.js';
import { UploadSizeError } from '../adapters/local-disk.driver.js';
import { contentDisposition } from '../content-disposition.js';
import type { PrivateFileQuery } from '../dtos/files.dto.js';

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
};

/** Express puts the `*` segment of `/public/*` in `params[0]`. */
function keyFrom(req: Request): string {
  return (req.params as Record<string, string>)['0'] ?? '';
}

async function send(
  res: Response,
  zone: StorageZone,
  key: string,
  cacheControl: string,
  disposition?: string,
): Promise<void> {
  // An invalid key is answered exactly like a missing file: telling a prober
  // which strings the grammar rejects helps nobody else.
  if (!isValidStorageKey(key)) throw new NotFoundError('File not found');
  const object = await storageDriver().open(zone, key);
  if (!object) throw new NotFoundError('File not found');

  res.status(200);
  res.setHeader('Content-Type', CONTENT_TYPES[extname(key)] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(object.size));
  res.setHeader('Cache-Control', cacheControl);
  if (disposition) res.setHeader('Content-Disposition', disposition);
  // Stops a browser from sniffing an uploaded file into something executable.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  await pipeline(object.stream, res);
}

/**
 * Keys are never reused (UUID per upload), so a public file can be cached for a
 * year and never revalidated — a replaced product photo is a new key.
 */
export async function getPublicFile(req: Request, res: Response): Promise<void> {
  await send(res, 'public', keyFrom(req), 'public, max-age=31536000, immutable');
}

/**
 * The signature is the authorisation. No Bearer token is read here on purpose:
 * the link is handed to image widgets and download managers that cannot send
 * one. `no-store` so a shared device keeps no copy after the link expires.
 */
export async function getPrivateFile(req: Request, res: Response): Promise<void> {
  const key = keyFrom(req);
  const { expires, signature, name } = req.query as unknown as PrivateFileQuery;
  if (!urlSigner().verify('private', key, expires, signature, new Date(), name)) {
    throw new ForbiddenError('File link is invalid or has expired', undefined, 'file_link_invalid');
  }
  // A document link names its file and is saved, not rendered; a bare link
  // (no name) keeps the inline behaviour images need.
  await send(
    res,
    'private',
    key,
    'private, no-store',
    name === undefined ? undefined : contentDisposition(name),
  );
}

/**
 * The local driver's direct-upload endpoint — what a presigned S3 PUT is in
 * production. The token (not a session) is the permission: it was issued after
 * the owning feature checked the caller, and it names one key, one exact size
 * and one content type. The body is streamed to disk, never buffered.
 *
 * 404 when the configured driver is not local: with S3 nobody should be
 * uploading here, and a link that silently wrote to one machine's disk is the
 * bug the S3 driver exists to prevent.
 */
export async function putUpload(req: Request, res: Response): Promise<void> {
  const driver = localUploadDriver();
  if (!driver) throw new NotFoundError('Not found');

  const grant = urlSigner().verifyUpload(String(req.params['token'] ?? ''));
  // Same rule S3 applies to a signed Content-Type: send exactly what was granted.
  if (
    !grant ||
    grant.zone !== 'private' ||
    !isValidStorageKey(grant.key) ||
    req.headers['content-type'] !== grant.contentType
  ) {
    throw new ForbiddenError(
      'Upload link is invalid or has expired',
      undefined,
      'upload_link_invalid',
    );
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > grant.bytes) {
    throw new PayloadTooLargeError(
      'The file is larger than declared',
      { max_bytes: grant.bytes },
      'upload_size_mismatch',
    );
  }

  try {
    await driver.putStream('private', grant.key, req, grant.bytes);
  } catch (error) {
    if (error instanceof UploadSizeError) {
      throw new BusinessError(
        422,
        'The uploaded file is not the declared size',
        'upload_size_mismatch',
        {
          max_bytes: grant.bytes,
        },
      );
    }
    throw error;
  }
  res.status(204).end();
}
