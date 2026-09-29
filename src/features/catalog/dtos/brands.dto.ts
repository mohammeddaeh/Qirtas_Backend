import { z } from 'zod';
import { bulkBodySchema } from '../../../core/bulk/bulk.js';
import { queryBooleanSchema } from '../../../core/validation/common-schemas.js';
import type { WireImage } from '../../../core/media/media.service.js';
import type { CatalogBrandRow } from '../schemas/brands.schema.js';
import { wireImageSchema } from './common.dto.js';

export const brandsFilterQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    /** `true` = the archive only. */
    archived: queryBooleanSchema.optional(),
  })
  .strict();
export type BrandsFilterQuery = z.infer<typeof brandsFilterQuerySchema>;

export const createBrandBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    logo_image_id: z.number().int().positive().nullable().optional(),
  })
  .strict();
export type CreateBrandBody = z.infer<typeof createBrandBodySchema>;

export const updateBrandBodySchema = createBrandBodySchema
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateBrandBody = z.infer<typeof updateBrandBodySchema>;

/**
 * `POST /catalog/brands/bulk` — multi-select actions on the brand list.
 *
 * Exactly what the brand sheet does to one brand, run per id (see
 * `core/bulk/bulk.ts`): `delete` · `archive` · `unarchive` are their own
 * routes, so `brand_in_use` still refuses deleting a brand a product carries.
 * Rename is not a list action — a name is typed per brand.
 */
export const BRAND_BULK_ACTIONS = ['delete', 'archive', 'unarchive'] as const;

/** Retire/restore — `records.archive` on top of `catalog.delete`, like `POST /brands/:id/archive`. */
export const BRAND_BULK_ARCHIVE_ACTIONS: readonly string[] = ['archive', 'unarchive'];

export const brandBulkBodySchema = bulkBodySchema(BRAND_BULK_ACTIONS).strict();
export type BrandBulkBody = z.infer<typeof brandBulkBodySchema>;

export const brandResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  logo: wireImageSchema,
  archived_at: z.string().nullable(),
  created_at: z.string(),
});

export interface WireBrand {
  id: number;
  name: string;
  logo: WireImage | null;
  archived_at: string | null;
  created_at: string;
}

export function toWireBrand(row: CatalogBrandRow, logo: WireImage | null): WireBrand {
  return {
    id: row.id,
    name: row.name,
    logo,
    archived_at: row.archived_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}
