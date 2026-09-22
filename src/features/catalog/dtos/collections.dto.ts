import { z } from 'zod';
import type { WireImage } from '../../../core/media/media.service.js';
import type { CatalogCollectionRow } from '../schemas/collections.schema.js';
import { nameArSchema, nameEnSchema, sortOrderSchema, wireImageSchema } from './common.dto.js';
import { productListItemSchema, type WireProductListItem } from './products.dto.js';

const fields = {
  name_ar: nameArSchema(120),
  name_en: nameEnSchema(120),
  image_id: z.number().int().positive().nullable().optional(),
  starts_at: z.string().datetime({ offset: true }).nullable().optional(),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  is_active: z.boolean().optional(),
  sort_order: sortOrderSchema.optional(),
};

const windowIsOrdered = (b: { starts_at?: string | null; ends_at?: string | null }) =>
  !b.starts_at || !b.ends_at || new Date(b.starts_at) < new Date(b.ends_at);
const windowMessage = { message: 'ends_at must be after starts_at', path: ['ends_at'] };

export const createCollectionBodySchema = z
  .object(fields)
  .strict()
  .refine(windowIsOrdered, windowMessage);
export type CreateCollectionBody = z.infer<typeof createCollectionBodySchema>;

export const updateCollectionBodySchema = z
  .object({ ...fields, name_ar: fields.name_ar.optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' })
  .refine(windowIsOrdered, windowMessage);
export type UpdateCollectionBody = z.infer<typeof updateCollectionBodySchema>;

export const replaceCollectionProductsBodySchema = z
  .object({ product_ids: z.array(z.number().int().positive()).max(500) })
  .strict();
export type ReplaceCollectionProductsBody = z.infer<typeof replaceCollectionProductsBodySchema>;

export const collectionResponseSchema = z.object({
  id: z.number().int(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
  image: wireImageSchema,
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
  products_count: z.number().int(),
});

export const collectionDetailResponseSchema = collectionResponseSchema.extend({
  products: z.array(productListItemSchema),
});

export interface WireCollection {
  id: number;
  name_ar: string;
  name_en: string | null;
  image: WireImage | null;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  sort_order: number;
  products_count: number;
}

export interface WireCollectionDetail extends WireCollection {
  products: WireProductListItem[];
}

export function toWireCollection(
  row: CatalogCollectionRow,
  image: WireImage | null,
  productsCount: number,
): WireCollection {
  return {
    id: row.id,
    name_ar: row.name_ar,
    name_en: row.name_en,
    image,
    starts_at: row.starts_at?.toISOString() ?? null,
    ends_at: row.ends_at?.toISOString() ?? null,
    is_active: row.is_active,
    sort_order: row.sort_order,
    products_count: productsCount,
  };
}
