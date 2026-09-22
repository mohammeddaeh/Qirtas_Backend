import { z } from 'zod';
import { queryBooleanSchema } from '../../../core/validation/common-schemas.js';
import type { WireImage } from '../../../core/media/media.service.js';
import {
  PRICE_POLICIES,
  PRICING_CURRENCIES,
  PRODUCT_KINDS,
  type PricePolicy,
  type PricingCurrency,
  type ProductKind,
} from '../schemas/catalog-enums.schema.js';
import type { CatalogCategoryRow } from '../schemas/categories.schema.js';
import { nameArSchema, nameEnSchema, sortOrderSchema, wireImageSchema } from './common.dto.js';

export const categoriesFilterQuerySchema = z
  .object({
    /** `true` = the archive only; absent/`false` = live categories only. Never both — see record_archive_test.dart. */
    archived: queryBooleanSchema.optional(),
  })
  .strict();
export type CategoriesFilterQuery = z.infer<typeof categoriesFilterQuerySchema>;

// `null` is a real value on the three inheritable fields ("inherit from the
// parent"), distinct from absent ("leave unchanged") on update.
const inheritable = {
  product_kind: z.enum(PRODUCT_KINDS).nullable().optional(),
  price_policy: z.enum(PRICE_POLICIES).nullable().optional(),
  pricing_currency: z.enum(PRICING_CURRENCIES).nullable().optional(),
};

export const createCategoryBodySchema = z
  .object({
    parent_id: z.number().int().positive().nullable().optional(),
    name_ar: nameArSchema(120),
    name_en: nameEnSchema(120),
    ...inheritable,
    image_id: z.number().int().positive().nullable().optional(),
    sort_order: sortOrderSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .strict();
export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;

export const updateCategoryBodySchema = createCategoryBodySchema
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;

export const replaceCategoryAttributesBodySchema = z
  .object({ attribute_type_ids: z.array(z.number().int().positive()).max(30) })
  .strict();
export type ReplaceCategoryAttributesBody = z.infer<typeof replaceCategoryAttributesBodySchema>;

const effectiveSchema = z.object({
  product_kind: z.enum(PRODUCT_KINDS).nullable(),
  price_policy: z.enum(PRICE_POLICIES).nullable(),
  pricing_currency: z.enum(PRICING_CURRENCIES).nullable(),
});

export const categoryResponseSchema = z.object({
  id: z.number().int(),
  code: z.string().nullable(),
  parent_id: z.number().int().nullable(),
  level: z.number().int(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
  product_kind: z.enum(PRODUCT_KINDS).nullable(),
  price_policy: z.enum(PRICE_POLICIES).nullable(),
  pricing_currency: z.enum(PRICING_CURRENCIES).nullable(),
  /** The values that actually apply after walking up the tree — what the client shows. */
  effective: effectiveSchema,
  image: wireImageSchema,
  sort_order: z.number().int(),
  is_active: z.boolean(),
  archived_at: z.string().nullable(),
  children_count: z.number().int(),
});

const attributeRefSchema = z.object({
  id: z.number().int(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
});

export const categoryDetailResponseSchema = categoryResponseSchema.extend({
  /** Root first. Lets the detail screen draw the breadcrumb without a second request. */
  path: z.array(
    z.object({ id: z.number().int(), name_ar: z.string(), name_en: z.string().nullable() }),
  ),
  attribute_types: z.object({
    own: z.array(attributeRefSchema),
    /** From ancestors — shown locked, edited on the ancestor that owns them. */
    inherited: z.array(attributeRefSchema.extend({ from_category_id: z.number().int() })),
  }),
  is_deletable: z.boolean(),
  is_archivable: z.boolean(),
  /** Live children block both delete and archive; the count makes the refusal a sentence. */
  active_children_count: z.number().int(),
  // Products ever (blocks delete) and live products (blocks archive).
  products_count: z.number().int(),
  active_products_count: z.number().int(),
});

export interface WireCategoryEffective {
  product_kind: ProductKind | null;
  price_policy: PricePolicy | null;
  pricing_currency: PricingCurrency | null;
}

export interface WireCategory {
  id: number;
  code: string | null;
  parent_id: number | null;
  level: number;
  name_ar: string;
  name_en: string | null;
  product_kind: ProductKind | null;
  price_policy: PricePolicy | null;
  pricing_currency: PricingCurrency | null;
  effective: WireCategoryEffective;
  image: WireImage | null;
  sort_order: number;
  is_active: boolean;
  archived_at: string | null;
  children_count: number;
}

export interface WireAttributeRef {
  id: number;
  name_ar: string;
  name_en: string | null;
}

export interface WireCategoryDetail extends WireCategory {
  path: { id: number; name_ar: string; name_en: string | null }[];
  attribute_types: {
    own: WireAttributeRef[];
    inherited: (WireAttributeRef & { from_category_id: number })[];
  };
  is_deletable: boolean;
  is_archivable: boolean;
  active_children_count: number;
  products_count: number;
  active_products_count: number;
}

export function toWireCategory(
  row: CatalogCategoryRow,
  effective: WireCategoryEffective,
  image: WireImage | null,
  childrenCount: number,
): WireCategory {
  return {
    id: row.id,
    code: row.code,
    parent_id: row.parent_id,
    level: row.level,
    name_ar: row.name_ar,
    name_en: row.name_en,
    product_kind: row.product_kind,
    price_policy: row.price_policy,
    pricing_currency: row.pricing_currency,
    effective,
    image,
    sort_order: row.sort_order,
    is_active: row.is_active,
    archived_at: row.archived_at?.toISOString() ?? null,
    children_count: childrenCount,
  };
}
