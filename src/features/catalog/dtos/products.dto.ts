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
import {
  BARCODE_SOURCES,
  PRODUCT_STATUSES,
  VARIANT_STATUSES,
  type BarcodeSource,
  type ProductStatus,
  type VariantStatus,
} from '../schemas/products.schema.js';
import { nameArSchema, nameEnSchema, sortOrderSchema, wireImageSchema } from './common.dto.js';
import type { BarcodeAmbiguity } from '../services/barcode-rules.js';

// ── Requests ────────────────────────────────────────────────────────────────

export const productsFilterQuerySchema = z
  .object({
    /** Names and keywords, folded; a code-shaped term also matches barcodes and SKUs exactly. */
    search: z.string().trim().min(1).max(100).optional(),
    /** Includes every subcategory below it. */
    category_id: z.coerce.number().int().positive().optional(),
    brand_id: z.coerce.number().int().positive().optional(),
    status: z.enum(PRODUCT_STATUSES).optional(),
    kind: z.enum(PRODUCT_KINDS).optional(),
    archived: queryBooleanSchema.optional(),
  })
  .strict();
export type ProductsFilterQuery = z.infer<typeof productsFilterQuerySchema>;

const idList = (max: number) => z.array(z.number().int().positive()).max(max);
const imageIds = idList(12);

const unitInputSchema = z
  .object({
    unit_id: z.number().int().positive(),
    /** Base units per one of this unit — a box of 12 is `12`, a 2.5 m roll is `2.5`. */
    factor: z.number().positive().max(1_000_000),
    sellable_online: z.boolean().default(true),
    sellable_at_pos: z.boolean().default(true),
  })
  .strict();

const barcodeInputSchema = z
  .object({ code: z.string().min(1).max(64), unit_id: z.number().int().positive() })
  .strict();

export const variantInputSchema = z
  .object({
    sku: z.string().trim().min(1).max(40).optional(),
    attribute_value_ids: idList(3).default([]),
    base_unit_id: z.number().int().positive(),
    /** Extra units, and optionally the base unit's own flags (factor must then be 1). */
    units: z.array(unitInputSchema).max(10).default([]),
    barcodes: z.array(barcodeInputSchema).max(20).default([]),
    image_ids: imageIds.default([]),
    sort_order: sortOrderSchema.optional(),
  })
  .strict();
export type VariantInput = z.infer<typeof variantInputSchema>;

const productFields = {
  category_id: z.number().int().positive(),
  brand_id: z.number().int().positive().nullable().optional(),
  kind: z.enum(PRODUCT_KINDS).optional(),
  is_sellable: z.boolean().optional(),
  name_ar: nameArSchema(200),
  name_en: nameEnSchema(200),
  description_ar: z.string().trim().max(5000).nullable().optional(),
  description_en: z.string().trim().max(5000).nullable().optional(),
  search_keywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  price_policy: z.enum(PRICE_POLICIES).nullable().optional(),
  pricing_currency: z.enum(PRICING_CURRENCIES).nullable().optional(),
  image_ids: imageIds.optional(),
};

export const createProductBodySchema = z
  .object({
    ...productFields,
    /** A new product starts as `draft` unless the form publishes it at once. */
    status: z.enum(['draft', 'active']).default('draft'),
    variants: z.array(variantInputSchema).min(1).max(200),
  })
  .strict();
export type CreateProductBody = z.infer<typeof createProductBodySchema>;

export const updateProductBodySchema = z
  .object({
    ...productFields,
    category_id: productFields.category_id.optional(),
    name_ar: productFields.name_ar.optional(),
    status: z.enum(PRODUCT_STATUSES).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateProductBody = z.infer<typeof updateProductBodySchema>;

/** `base_unit_id` is not editable: stock is counted in it, so changing it is a new variant. */
export const updateVariantBodySchema = z
  .object({
    sku: z.string().trim().min(1).max(40).optional(),
    attribute_value_ids: idList(3).optional(),
    status: z.enum(VARIANT_STATUSES).optional(),
    sort_order: sortOrderSchema.optional(),
    image_ids: imageIds.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateVariantBody = z.infer<typeof updateVariantBodySchema>;

export const replaceVariantUnitsBodySchema = z
  .object({ units: z.array(unitInputSchema).max(10) })
  .strict();
export type ReplaceVariantUnitsBody = z.infer<typeof replaceVariantUnitsBodySchema>;

export const addBarcodeBodySchema = barcodeInputSchema;
export type AddBarcodeBody = z.infer<typeof addBarcodeBodySchema>;

export const generateBarcodeBodySchema = z
  .object({ unit_id: z.number().int().positive() })
  .strict();
export type GenerateBarcodeBody = z.infer<typeof generateBarcodeBodySchema>;

export const barcodeLookupQuerySchema = z.object({ code: z.string().min(1).max(64) }).strict();

// ── Responses ───────────────────────────────────────────────────────────────

const refSchema = z.object({
  id: z.number().int(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
});

export const productListItemSchema = z.object({
  id: z.number().int(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
  category: refSchema,
  brand: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  kind: z.enum(PRODUCT_KINDS),
  status: z.enum(PRODUCT_STATUSES),
  is_sellable: z.boolean(),
  thumbnail: wireImageSchema,
  variants_count: z.number().int(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const variantValueSchema = z.object({
  attribute_type_id: z.number().int(),
  attribute_value_id: z.number().int(),
  value_ar: z.string(),
  value_en: z.string().nullable(),
  color_hex: z.string().nullable(),
});

const variantUnitSchema = z.object({
  id: z.number().int(),
  unit_id: z.number().int(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
  factor: z.number(),
  is_base: z.boolean(),
  allows_fraction: z.boolean(),
  sellable_online: z.boolean(),
  sellable_at_pos: z.boolean(),
});

export const barcodeResponseSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  unit_id: z.number().int(),
  source: z.enum(BARCODE_SOURCES),
  /** Printed on another (variant, unit) as well — scanning it asks which one. */
  is_shared: z.boolean(),
});

export const variantResponseSchema = z.object({
  id: z.number().int(),
  sku: z.string(),
  status: z.enum(VARIANT_STATUSES),
  sort_order: z.number().int(),
  base_unit_id: z.number().int(),
  /** «أزرق · 0.5» — the values joined, for lists and scan results. Empty for a simple product. */
  label_ar: z.string(),
  label_en: z.string().nullable(),
  values: z.array(variantValueSchema),
  units: z.array(variantUnitSchema),
  barcodes: z.array(barcodeResponseSchema),
  images: z.array(wireImageSchema.unwrap()),
});

export const productDetailSchema = productListItemSchema.extend({
  description_ar: z.string().nullable(),
  description_en: z.string().nullable(),
  search_keywords: z.array(z.string()),
  price_policy: z.enum(PRICE_POLICIES).nullable(),
  pricing_currency: z.enum(PRICING_CURRENCIES).nullable(),
  effective: z.object({
    price_policy: z.enum(PRICE_POLICIES).nullable(),
    pricing_currency: z.enum(PRICING_CURRENCIES).nullable(),
  }),
  category_path: z.array(refSchema),
  /** What the variant form may offer — the category's own and inherited allowed types. */
  allowed_attribute_type_ids: z.array(z.number().int()),
  /** The attributes that distinguish this product's variants, in display order. */
  axes: z.array(refSchema),
  images: z.array(wireImageSchema.unwrap()),
  variants: z.array(variantResponseSchema),
  is_deletable: z.boolean(),
  is_archivable: z.boolean(),
});

export const barcodeLookupResponseSchema = z.object({
  code: z.string(),
  ambiguity: z.enum(['none', 'unit', 'item']),
  matches: z.array(
    z.object({
      barcode_id: z.number().int(),
      product_id: z.number().int(),
      product_name_ar: z.string(),
      product_name_en: z.string().nullable(),
      product_status: z.enum(PRODUCT_STATUSES),
      variant_id: z.number().int(),
      sku: z.string(),
      variant_label_ar: z.string(),
      variant_status: z.enum(VARIANT_STATUSES),
      unit_id: z.number().int(),
      unit_name_ar: z.string(),
      factor: z.number(),
      thumbnail: wireImageSchema,
    }),
  ),
});

export const sharedBarcodeSchema = z.object({
  code: z.string(),
  matches_count: z.number().int(),
  ambiguity: z.enum(['unit', 'item']),
});

export interface WireRef {
  id: number;
  name_ar: string;
  name_en: string | null;
}

export interface WireProductListItem {
  id: number;
  name_ar: string;
  name_en: string | null;
  category: WireRef;
  brand: { id: number; name: string } | null;
  kind: ProductKind;
  status: ProductStatus;
  is_sellable: boolean;
  thumbnail: WireImage | null;
  variants_count: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WireVariantValue {
  attribute_type_id: number;
  attribute_value_id: number;
  value_ar: string;
  value_en: string | null;
  color_hex: string | null;
}

export interface WireVariantUnit {
  id: number;
  unit_id: number;
  name_ar: string;
  name_en: string | null;
  factor: number;
  is_base: boolean;
  allows_fraction: boolean;
  sellable_online: boolean;
  sellable_at_pos: boolean;
}

export interface WireBarcode {
  id: number;
  code: string;
  unit_id: number;
  source: BarcodeSource;
  is_shared: boolean;
}

export interface WireVariant {
  id: number;
  sku: string;
  status: VariantStatus;
  sort_order: number;
  base_unit_id: number;
  label_ar: string;
  label_en: string | null;
  values: WireVariantValue[];
  units: WireVariantUnit[];
  barcodes: WireBarcode[];
  images: WireImage[];
}

export interface WireProductDetail extends WireProductListItem {
  description_ar: string | null;
  description_en: string | null;
  search_keywords: string[];
  price_policy: PricePolicy | null;
  pricing_currency: PricingCurrency | null;
  effective: { price_policy: PricePolicy | null; pricing_currency: PricingCurrency | null };
  category_path: WireRef[];
  allowed_attribute_type_ids: number[];
  axes: WireRef[];
  images: WireImage[];
  variants: WireVariant[];
  is_deletable: boolean;
  is_archivable: boolean;
}

export interface WireBarcodeLookup {
  code: string;
  ambiguity: BarcodeAmbiguity;
  matches: {
    barcode_id: number;
    product_id: number;
    product_name_ar: string;
    product_name_en: string | null;
    product_status: ProductStatus;
    variant_id: number;
    sku: string;
    variant_label_ar: string;
    variant_status: VariantStatus;
    unit_id: number;
    unit_name_ar: string;
    factor: number;
    thumbnail: WireImage | null;
  }[];
}
