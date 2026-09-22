import { BusinessError, ValidationError } from '../http/api-error.js';
import { storageDriver, type StorageZone } from './ports/storage-driver.js';
import { ImageRejectedError, processImage, type ImageVariantName } from './image-processing.js';
import { newStorageKeyBase, variantKey } from './storage-keys.js';
import { urlSigner } from './composition.js';
import * as mediaAssetsRepository from './repositories/media-assets.repository.js';
import type { MediaAssetRow } from './schemas/media-assets.schema.js';

/** Path under which `files.routes.ts` is mounted. URLs on the wire are relative to the API host. */
export const FILES_BASE_PATH = '/api/v1/files';

/**
 * What a client receives for an image. URLs, not keys: the client should not
 * know how keys map to routes. They are **relative** to the API origin the
 * client already talks to, so they survive the server moving host.
 */
export interface WireImage {
  id: number;
  width: number;
  height: number;
  urls: Record<ImageVariantName, string>;
}

/**
 * Stores an uploaded image in the **public** zone as three WebP renditions and
 * records it. Nothing references it yet: the caller attaches it when the form
 * that uploaded it is saved (`attached_at`).
 */
export async function storePublicImage(input: {
  bytes: Buffer;
  originalFilename: string | null;
  uploadedByUserId: number | null;
}): Promise<WireImage> {
  let processed;
  try {
    processed = await processImage(input.bytes);
  } catch (error) {
    if (!(error instanceof ImageRejectedError)) throw error;
    // Literal keys, one per branch: `check:messages` reads the throw site, and a
    // key looked up from a map is invisible to it.
    switch (error.reason) {
      case 'unsupported_format':
        throw new BusinessError(422, error.message, 'image_unsupported_format');
      case 'too_small':
        throw new BusinessError(422, error.message, 'image_too_small');
      case 'unreadable':
        throw new BusinessError(422, error.message, 'image_unreadable');
    }
  }

  const zone: StorageZone = 'public';
  const keyBase = newStorageKeyBase('img');
  const written: string[] = [];
  try {
    for (const variant of processed.variants) {
      const key = variantKey(keyBase, variant.name, 'webp');
      await storageDriver().put(zone, key, variant.bytes);
      written.push(key);
    }

    const row = await mediaAssetsRepository.insert({
      zone,
      kind: 'image',
      key_base: keyBase,
      original_filename: input.originalFilename?.slice(0, 255) ?? null,
      original_bytes: input.bytes.length,
      width: processed.width,
      height: processed.height,
      variants: processed.variants.map((v, i) => ({
        name: v.name,
        key: written[i]!,
        width: v.width,
        height: v.height,
        bytes: v.bytes.length,
      })),
      uploaded_by_user_id: input.uploadedByUserId,
    });
    return toWireImage(row);
  } catch (error) {
    // Files without a row are unreachable and never cleaned up — remove them.
    await Promise.all(
      written.map((key) =>
        storageDriver()
          .delete(zone, key)
          .catch(() => undefined),
      ),
    );
    throw error;
  }
}

export function toWireImage(row: MediaAssetRow): WireImage {
  const urls = {} as Record<ImageVariantName, string>;
  for (const variant of row.variants) {
    urls[variant.name as ImageVariantName] = fileUrl(row.zone, variant.key);
  }
  return { id: row.id, width: row.width, height: row.height, urls };
}

/**
 * Public files get a stable URL; private files a signed one that expires. The
 * caller must have checked the reader's right to a private file **before**
 * asking for its URL — the link is the permission.
 */
export function fileUrl(zone: StorageZone, key: string): string {
  if (zone === 'public') return `${FILES_BASE_PATH}/public/${key}`;
  const { expires, signature } = urlSigner().sign(zone, key);
  return `${FILES_BASE_PATH}/private/${key}?expires=${expires}&signature=${signature}`;
}

/**
 * Loads public images a record is about to reference and marks them attached,
 * or refuses with a 422 naming the field — so a form cannot save a pointer to
 * an image that does not exist, is a private file, or is not an image.
 *
 * Call inside the same request that saves the referencing row.
 */
export async function attachPublicImages(
  field: string,
  ids: number[],
): Promise<Map<number, WireImage>> {
  const unique = [...new Set(ids)];
  const rows = await mediaAssetsRepository.findManyByIds(unique);
  const usable = rows.filter((row) => row.kind === 'image' && row.zone === 'public');
  if (usable.length !== unique.length) {
    throw new ValidationError({ [field]: ['Unknown image id'] });
  }
  await mediaAssetsRepository.markAttached(unique, new Date());
  return new Map(usable.map((row) => [row.id, toWireImage(row)]));
}

/** Wire images for rows already attached — no validation, just rendering. */
export async function publicImagesByIds(ids: number[]): Promise<Map<number, WireImage>> {
  const rows = await mediaAssetsRepository.findManyByIds([...new Set(ids)]);
  return new Map(rows.map((row) => [row.id, toWireImage(row)]));
}
