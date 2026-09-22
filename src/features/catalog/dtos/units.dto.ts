import { z } from 'zod';
import type { CatalogUnitRow } from '../schemas/units.schema.js';
import { nameArSchema, nameEnSchema, sortOrderSchema } from './common.dto.js';

export const createUnitBodySchema = z
  .object({
    name_ar: nameArSchema(60),
    name_en: nameEnSchema(60),
    allows_fraction: z.boolean().default(false),
    sort_order: sortOrderSchema.optional(),
  })
  .strict();
export type CreateUnitBody = z.infer<typeof createUnitBodySchema>;

/**
 * `allows_fraction` is absent on purpose: turning a fractional unit whole once
 * stock was counted in it (2.5 m) would make existing quantities illegal, and
 * the reverse is a different unit. Changing it is a new unit.
 */
export const updateUnitBodySchema = z
  .object({
    name_ar: nameArSchema(60).optional(),
    name_en: nameEnSchema(60),
    sort_order: sortOrderSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateUnitBody = z.infer<typeof updateUnitBodySchema>;

export const unitResponseSchema = z.object({
  id: z.number().int(),
  code: z.string().nullable(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
  allows_fraction: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
});

export interface WireUnit {
  id: number;
  code: string | null;
  name_ar: string;
  name_en: string | null;
  allows_fraction: boolean;
  is_active: boolean;
  sort_order: number;
}

export function toWireUnit(row: CatalogUnitRow): WireUnit {
  return {
    id: row.id,
    code: row.code,
    name_ar: row.name_ar,
    name_en: row.name_en,
    allows_fraction: row.allows_fraction,
    is_active: row.is_active,
    sort_order: row.sort_order,
  };
}
