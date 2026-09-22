import { z } from 'zod';

export const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
export type IdParams = z.infer<typeof idParamsSchema>;

/** Arabic is required on every catalog name; English is optional and falls back to Arabic on the client. */
export const nameArSchema = (max: number) => z.string().trim().min(1).max(max);
export const nameEnSchema = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const sortOrderSchema = z.number().int().min(0).max(100_000);

/** Mirrors `WireImage` (core/media/media.service.ts) for OpenAPI. */
export const wireImageSchema = z
  .object({
    id: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
    urls: z.object({ thumb: z.string(), medium: z.string(), large: z.string() }),
  })
  .nullable();
