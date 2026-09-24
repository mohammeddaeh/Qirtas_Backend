import { z } from 'zod';
import {
  COUNT_SCOPES,
  TRANSFER_STATUSES,
  type CountScope,
  type CountStatus,
  type DiscrepancyResolution,
  type TransferStatus,
} from '../schemas/transfers.schema.js';

/** Transfers and stocktakes — inventory_suppliers.md §٤–§٥, rest_api.md §23. */

const qty = z.number().positive().max(1_000_000_000);
const branchId = z.coerce.number().int().positive();

export const transferBodySchema = z
  .object({
    from_branch_id: z.number().int().positive(),
    to_branch_id: z.number().int().positive(),
    note: z.string().trim().max(500).nullable().optional(),
    lines: z
      .array(z.object({ variant_id: z.number().int().positive(), qty_requested: qty }).strict())
      .min(1)
      .max(200),
  })
  .strict();
export type TransferBody = z.infer<typeof transferBodySchema>;

/**
 * Shipping and receiving both send quantities per line, and both may omit a
 * line: omitted means "as asked" when shipping and "as shipped" when
 * receiving — the common case, typed once.
 */
export const receiveTransferBodySchema = z
  .object({
    lines: z
      .array(z.object({ variant_id: z.number().int().positive(), qty: z.number().min(0).max(1_000_000_000) }).strict())
      .max(200)
      .default([]),
  })
  .strict();
export type ReceiveTransferBody = z.infer<typeof receiveTransferBodySchema>;

export const resolveTransferBodySchema = z
  .object({
    resolution: z.enum(['loss', 'returned']),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const transfersFilterQuerySchema = z
  .object({ branch_id: branchId.optional(), status: z.enum(TRANSFER_STATUSES).optional() })
  .strict();

export const countBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    scope: z.enum(COUNT_SCOPES),
    /** Required for a category count — the subtree to walk. */
    category_id: z.number().int().positive().nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((body) => body.scope !== 'category' || body.category_id != null, {
    message: 'A category count needs its category',
    path: ['category_id'],
  });
export type CountBody = z.infer<typeof countBodySchema>;

export const countLineBodySchema = z
  .object({ variant_id: z.number().int().positive(), counted_qty: z.number().min(0).max(1_000_000_000) })
  .strict();
export type CountLineBody = z.infer<typeof countLineBodySchema>;

export const countsFilterQuerySchema = z
  .object({
    branch_id: branchId.optional(),
    status: z.enum(['open', 'pending_approval', 'closed', 'cancelled']).optional(),
  })
  .strict();

// ── Responses ───────────────────────────────────────────────────────────────

export interface WireTransferLine {
  id: number;
  variant_id: number;
  sku: string;
  product_name_ar: string;
  qty_requested: number;
  qty_shipped: number | null;
  qty_received: number | null;
}

export interface WireTransfer {
  id: number;
  number: string;
  from_branch_id: number;
  from_branch_name: string;
  to_branch_id: number;
  to_branch_name: string;
  status: TransferStatus;
  note: string | null;
  resolution: DiscrepancyResolution | null;
  resolution_note: string | null;
  shipped_at: string | null;
  received_at: string | null;
  created_at: string;
  /** What this document may still become — the screen's buttons come from here. */
  next_states: TransferStatus[];
  lines: WireTransferLine[];
}

export interface WireCountLine {
  variant_id: number;
  sku: string;
  product_name_ar: string;
  counted_qty: number;
  /** `null` while the count is open — a blind count shows nobody the expected number (§٥). */
  system_qty: number | null;
  diff: number | null;
  counted_at: string;
}

export interface WireCount {
  id: number;
  number: string;
  branch_id: number;
  scope: CountScope;
  category_id: number | null;
  status: CountStatus;
  note: string | null;
  diff_value_syp: number | null;
  counted_lines: number;
  created_at: string;
  closed_at: string | null;
  lines: WireCountLine[];
}
