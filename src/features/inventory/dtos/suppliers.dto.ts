import { z } from 'zod';
import { queryBooleanSchema } from '../../../core/validation/common-schemas.js';
import type { SupplierRow } from '../schemas/suppliers.schema.js';

/** Suppliers — inventory_suppliers.md §٧, rest_api.md §22. */

export const suppliersFilterQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    /** `true` = the archive only; absent = live suppliers. Never both. */
    archived: queryBooleanSchema.optional(),
  })
  .strict();
export type SuppliersFilterQuery = z.infer<typeof suppliersFilterQuerySchema>;

const fields = {
  name: z.string().trim().min(1).max(150),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().email().max(150).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  is_active: z.boolean().optional(),
};

export const createSupplierBodySchema = z.object(fields).strict();
export type CreateSupplierBody = z.infer<typeof createSupplierBodySchema>;

export const updateSupplierBodySchema = z
  .object({ ...fields, name: fields.name.optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateSupplierBody = z.infer<typeof updateSupplierBodySchema>;

export const supplierResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  archived_at: z.string().nullable(),
  invoices_count: z.number().int(),
  is_deletable: z.boolean(),
  is_archivable: z.boolean(),
});

export interface WireSupplier {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  archived_at: string | null;
  /** Invoices ever — what decides delete against archive (rest_api.md §16). */
  invoices_count: number;
  is_deletable: boolean;
  is_archivable: boolean;
}

export function toWireSupplier(row: SupplierRow, invoicesCount: number): WireSupplier {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    is_active: row.is_active,
    archived_at: row.archived_at?.toISOString() ?? null,
    invoices_count: invoicesCount,
    is_deletable: invoicesCount === 0,
    is_archivable: row.archived_at === null,
  };
}
