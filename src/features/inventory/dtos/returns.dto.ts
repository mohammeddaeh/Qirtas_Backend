import { z } from 'zod';
import { qtySchema } from './stock.dto.js';

/** Returning goods to a supplier — inventory_suppliers.md §٧, rest_api.md §24. */

export const returnBodySchema = z
  .object({
    /**
     * The invoice the goods came in on. Not optional: it is where their cost
     * is read from, and it is what caps how much can go back.
     */
    receipt_id: z.number().int().positive(),
    /** Required — "why did it go back" is the first thing the supplier asks. */
    note: z.string().trim().min(1).max(500),
    lines: z
      .array(
        z
          .object({
            variant_id: z.number().int().positive(),
            /** In base units, positive. The movement it posts is negative. */
            qty_base: qtySchema,
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type ReturnBody = z.infer<typeof returnBodySchema>;

export const returnsFilterQuerySchema = z
  .object({
    branch_id: z.coerce.number().int().positive().optional(),
    supplier_id: z.coerce.number().int().positive().optional(),
    receipt_id: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type ReturnsFilterQuery = z.infer<typeof returnsFilterQuerySchema>;

export interface WireReturnLine {
  variant_id: number;
  sku: string | null;
  product_name_ar: string;
  qty_base: number;
  unit_cost_syp: number;
  line_total_syp: number;
}

export interface WireReturn {
  id: number;
  number: string;
  branch_id: number;
  branch_name: string;
  supplier_id: number;
  supplier_name: string;
  receipt_id: number;
  receipt_number: string;
  note: string;
  total_syp: number;
  created_at: string;
  created_by: string | null;
  lines: WireReturnLine[];
}

/**
 * What is still returnable on an invoice — the list the return screen is
 * built from. Sending it computed means the client never subtracts «received
 * minus already returned» itself and never offers a quantity the server will
 * refuse.
 */
export interface WireReturnableLine {
  variant_id: number;
  sku: string | null;
  product_name_ar: string;
  unit_name_ar: string;
  received_base: number;
  returned_base: number;
  returnable_base: number;
  unit_cost_syp: number;
  unit_cost_usd: number;
}
