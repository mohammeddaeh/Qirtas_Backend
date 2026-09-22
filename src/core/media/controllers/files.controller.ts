import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { extname } from 'node:path';
import { ForbiddenError, NotFoundError } from '../../http/api-error.js';
import { storageDriver, type StorageZone } from '../ports/storage-driver.js';
import { isValidStorageKey } from '../storage-keys.js';
import { urlSigner } from '../composition.js';
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
  const { expires, signature } = req.query as unknown as PrivateFileQuery;
  if (!urlSigner().verify('private', key, expires, signature)) {
    throw new ForbiddenError('File link is invalid or has expired', undefined, 'file_link_invalid');
  }
  await send(res, 'private', key, 'private, no-store');
}
