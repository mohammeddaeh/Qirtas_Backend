import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ImageRejectedError, processImage } from '../image-processing.js';

/**
 * The costly failures here make no noise: a variant that keeps the phone's GPS
 * block publishes where a staff member lives; a missing resize ships 5 MB into
 * every list card; a rotation lost with the EXIF shows every portrait photo
 * sideways. Each is asserted against its opposite.
 */

function photo(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
  const img = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  });
  return (format === 'jpeg' ? img.jpeg() : img.png()).toBuffer();
}

describe('processImage', () => {
  it('produces three WebP renditions bounded by their size', async () => {
    const result = await processImage(await photo(3000, 2000));
    expect(result.variants.map((v) => v.name)).toEqual(['thumb', 'medium', 'large']);
    for (const [variant, edge] of result.variants.map(
      (v, i) => [v, [320, 800, 1600][i]!] as const,
    )) {
      expect(Math.max(variant.width, variant.height)).toBe(edge);
      expect((await sharp(variant.bytes).metadata()).format).toBe('webp');
    }
    expect(result).toMatchObject({ width: 3000, height: 2000 });
  });

  it('never enlarges a small image', async () => {
    const result = await processImage(await photo(500, 400, 'png'));
    const large = result.variants.find((v) => v.name === 'large')!;
    expect([large.width, large.height]).toEqual([500, 400]);
  });

  it('strips EXIF (a phone photo carries its GPS position)', async () => {
    const withExif = await sharp(await photo(1200, 900))
      .withExif({ IFD0: { Copyright: 'staff home' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const result = await processImage(withExif);
    for (const variant of result.variants) {
      expect((await sharp(variant.bytes).metadata()).exif).toBeUndefined();
    }
  });

  it('applies the EXIF orientation before stripping it', async () => {
    // Stored landscape, flagged "rotate 90°" — a portrait photo as phones save it.
    const flagged = await sharp(await photo(1200, 800))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const result = await processImage(flagged);
    const large = result.variants.find((v) => v.name === 'large')!;
    expect(large.height).toBeGreaterThan(large.width);
    expect(result).toMatchObject({ width: 800, height: 1200 });
  });

  it.each([
    ['not an image', Buffer.from('%PDF-1.4 definitely a pdf'), 'unreadable'],
    ['a GIF', null, 'unsupported_format'],
    ['a 150px image', null, 'too_small'],
  ] as const)('rejects %s', async (_label, given, reason) => {
    const input =
      given ??
      (reason === 'unsupported_format'
        ? await sharp({ create: { width: 400, height: 400, channels: 3, background: '#000' } })
            .gif()
            .toBuffer()
        : await photo(150, 600));
    await expect(processImage(input)).rejects.toSatisfy(
      (e: unknown) => e instanceof ImageRejectedError && e.reason === reason,
    );
  });
});
