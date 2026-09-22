import { z } from 'zod';
import { ATTRIBUTE_DISPLAYS } from '../schemas/catalog-enums.schema.js';
import type {
  CatalogAttributeTypeRow,
  CatalogAttributeValueRow,
} from '../schemas/attributes.schema.js';
import { nameArSchema, nameEnSchema, sortOrderSchema } from './common.dto.js';

const colorHexSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Expected #RRGGBB')
  .transform((v) => v.toLowerCase());

export const createAttributeTypeBodySchema = z
  .object({
    name_ar: nameArSchema(80),
    name_en: nameEnSchema(80),
    display: z.enum(ATTRIBUTE_DISPLAYS).default('text'),
    sort_order: sortOrderSchema.optional(),
  })
  .strict();
export type CreateAttributeTypeBody = z.infer<typeof createAttributeTypeBodySchema>;

export const updateAttributeTypeBodySchema = z
  .object({
    name_ar: nameArSchema(80).optional(),
    name_en: nameEnSchema(80),
    display: z.enum(ATTRIBUTE_DISPLAYS).optional(),
    sort_order: sortOrderSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateAttributeTypeBody = z.infer<typeof updateAttributeTypeBodySchema>;

export const createAttributeValueBodySchema = z
  .object({
    value_ar: nameArSchema(80),
    value_en: nameEnSchema(80),
    color_hex: colorHexSchema.nullable().optional(),
    sort_order: sortOrderSchema.optional(),
  })
  .strict();
export type CreateAttributeValueBody = z.infer<typeof createAttributeValueBodySchema>;

export const updateAttributeValueBodySchema = z
  .object({
    value_ar: nameArSchema(80).optional(),
    value_en: nameEnSchema(80),
    color_hex: colorHexSchema.nullable().optional(),
    sort_order: sortOrderSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateAttributeValueBody = z.infer<typeof updateAttributeValueBodySchema>;

export const attributeValueResponseSchema = z.object({
  id: z.number().int(),
  attribute_type_id: z.number().int(),
  value_ar: z.string(),
  value_en: z.string().nullable(),
  color_hex: z.string().nullable(),
  sort_order: z.number().int(),
});

export const attributeTypeResponseSchema = z.object({
  id: z.number().int(),
  code: z.string().nullable(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
  display: z.enum(ATTRIBUTE_DISPLAYS),
  sort_order: z.number().int(),
  values: z.array(attributeValueResponseSchema),
  /** How many categories allow this type. A type in use cannot be deleted — the client says why instead of hiding the button. */
  categories_count: z.number().int(),
});

export interface WireAttributeValue {
  id: number;
  attribute_type_id: number;
  value_ar: string;
  value_en: string | null;
  color_hex: string | null;
  sort_order: number;
}

export interface WireAttributeType {
  id: number;
  code: string | null;
  name_ar: string;
  name_en: string | null;
  display: CatalogAttributeTypeRow['display'];
  sort_order: number;
  values: WireAttributeValue[];
  categories_count: number;
}

export function toWireAttributeValue(row: CatalogAttributeValueRow): WireAttributeValue {
  return {
    id: row.id,
    attribute_type_id: row.attribute_type_id,
    value_ar: row.value_ar,
    value_en: row.value_en,
    color_hex: row.color_hex,
    sort_order: row.sort_order,
  };
}

export function toWireAttributeType(
  row: CatalogAttributeTypeRow,
  values: readonly CatalogAttributeValueRow[],
  categoriesCount: number,
): WireAttributeType {
  return {
    id: row.id,
    code: row.code,
    name_ar: row.name_ar,
    name_en: row.name_en,
    display: row.display,
    sort_order: row.sort_order,
    values: values.map(toWireAttributeValue),
    categories_count: categoriesCount,
  };
}
