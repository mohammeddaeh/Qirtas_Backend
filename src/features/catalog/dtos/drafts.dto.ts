import { z } from 'zod';
import { nameArSchema, nameEnSchema } from './common.dto.js';

/** Branch drafts — inventory_suppliers.md §٢, rest_api.md §24. */

export const createDraftBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    name_ar: nameArSchema(200),
    name_en: nameEnSchema(200),
    /** Where the branch thinks it belongs — the administration may move it on approval. */
    category_id: z.number().int().positive(),
    base_unit_id: z.number().int().positive(),
    /** The code that was scanned and found nothing. Optional: some goods arrive unlabelled. */
    barcode: z.string().trim().min(4).max(32).optional(),
    image_id: z.number().int().positive().nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type CreateDraftBody = z.infer<typeof createDraftBodySchema>;

/**
 * Approving may correct what the branch guessed — it saw a box, not a
 * catalogue. Every field is optional: unchanged means "the branch had it
 * right", which is the common case.
 */
export const approveDraftBodySchema = z
  .object({
    name_ar: nameArSchema(200).optional(),
    name_en: nameEnSchema(200),
    category_id: z.number().int().positive().optional(),
    brand_id: z.number().int().positive().nullable().optional(),
  })
  .strict();
export type ApproveDraftBody = z.infer<typeof approveDraftBodySchema>;

export const mergeDraftBodySchema = z
  .object({ variant_id: z.number().int().positive() })
  .strict();
export type MergeDraftBody = z.infer<typeof mergeDraftBodySchema>;

export const draftsFilterQuerySchema = z
  .object({
    branch_id: z.coerce.number().int().positive().optional(),
    /** Open drafts by default — a decided one is an ordinary product now. */
    include_decided: z.coerce.boolean().optional(),
  })
  .strict();
export type DraftsFilterQuery = z.infer<typeof draftsFilterQuerySchema>;

/**
 * A draft is not sent as a `WireProductListItem`. That shape carries price,
 * listing and brand — answers a draft has none of, and a list that shows an
 * empty price column reads as «priced at nothing» rather than «not decided
 * yet». What a reviewer needs is here and nothing else.
 */
export interface WireDraft {
  id: number;
  name_ar: string;
  name_en: string | null;
  sku: string;
  variant_id: number;
  category_id: number;
  category_name_ar: string;
  status: string;
  branch_id: number | null;
  branch_name: string | null;
  created_at: Date;
  /** How old the decision is — the dashboard signal §٢ asks for. */
  age_days: number;
  barcodes: string[];
  /** Stock this draft already holds at the branch that made it. */
  on_hand: number;
}
