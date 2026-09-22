import sharp from 'sharp';

/**
 * Every catalog image is stored as three WebP renditions, never as the upload.
 *
 * | variant | longest edge | used by |
 * |---|---|---|
 * | `thumb`  | 320  | list and grid cards |
 * | `medium` | 800  | the product page |
 * | `large`  | 1600 | zoom |
 *
 * A 5 MB phone photo drawn into a 100-pixel card costs the customer on a slow
 * connection the whole 5 MB, for every card on the screen. The client also
 * compresses before uploading; this is the half that does not depend on every
 * client remembering to.
 *
 * **Metadata is stripped.** sharp drops EXIF unless asked to keep it, and it is
 * never asked: a photo taken on a phone carries the GPS position where it was
 * taken. `.rotate()` applies the EXIF orientation first, so stripping it does
 * not leave the image sideways.
 */

export const IMAGE_VARIANTS = [
  { name: 'thumb', size: 320 },
  { name: 'medium', size: 800 },
  { name: 'large', size: 1600 },
] as const;

export type ImageVariantName = (typeof IMAGE_VARIANTS)[number]['name'];

/** Formats accepted as input. HEIC is absent: sharp's prebuilt binaries cannot decode it; the app converts to JPEG first. */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

/**
 * Refuses decompression bombs: a small file declaring 50 000 × 50 000 pixels
 * would otherwise be decoded into gigabytes of memory before any size check.
 * 40 MP covers every phone camera in circulation.
 */
const MAX_INPUT_PIXELS = 40_000_000;

/** Below this, an image is too small to be worth showing on a product page. */
export const MIN_IMAGE_EDGE = 200;

export interface ProcessedVariant {
  name: ImageVariantName;
  bytes: Buffer;
  width: number;
  height: number;
}

export interface ProcessedImage {
  width: number;
  height: number;
  variants: ProcessedVariant[];
}

export type ImageRejection = 'unsupported_format' | 'too_small' | 'unreadable';

export class ImageRejectedError extends Error {
  constructor(public readonly reason: ImageRejection) {
    super(`Image rejected: ${reason}`);
    this.name = 'ImageRejectedError';
  }
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new ImageRejectedError('unreadable');
  }

  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    throw new ImageRejectedError('unsupported_format');
  }
  if (!meta.width || !meta.height) throw new ImageRejectedError('unreadable');

  // Orientation 5–8 swap the axes; the stored image is the rotated one.
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;
  if (Math.min(width, height) < MIN_IMAGE_EDGE) throw new ImageRejectedError('too_small');

  const variants: ProcessedVariant[] = [];
  for (const { name, size } of IMAGE_VARIANTS) {
    try {
      const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      variants.push({ name, bytes: data, width: info.width, height: info.height });
    } catch {
      throw new ImageRejectedError('unreadable');
    }
  }

  return { width, height, variants };
}
