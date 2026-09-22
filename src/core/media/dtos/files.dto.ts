import { z } from 'zod';

export const privateFileQuerySchema = z
  .object({
    expires: z.coerce.number().int().positive(),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type PrivateFileQuery = z.infer<typeof privateFileQuerySchema>;

/** Mirrors `WireImage` in media.service.ts for OpenAPI generation — keep the two in step. */
export const imageResponseSchema = z.object({
  id: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  urls: z.object({ thumb: z.string(), medium: z.string(), large: z.string() }),
});
