import { z } from 'zod';
import type { WireImage } from '../../../core/media/media.service.js';
import { DOCUMENT_KINDS, type DocumentKind } from './layout.schema.js';

const id = z.coerce.number().int().positive();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const templatesQuerySchema = z.object({ kind: z.enum(DOCUMENT_KINDS).optional() }).strict();

export const contextQuerySchema = z.object({ branch_id: id.optional() }).strict();

/**
 * A new template is either written from scratch (`kind` + `layout`) or copied
 * (`clone_from_id`) — copying is how a ready-made one is changed. Exactly one.
 */
export const createTemplateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(DOCUMENT_KINDS).optional(),
    layout: z.record(z.unknown()).optional(),
    clone_from_id: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.clone_from_id !== undefined
        ? b.kind === undefined && b.layout === undefined
        : b.kind !== undefined && b.layout !== undefined,
    {
      message: 'Send either clone_from_id, or kind with layout',
      path: ['clone_from_id'],
    },
  );
export type CreateTemplateBody = z.infer<typeof createTemplateBodySchema>;

export const updateTemplateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    layout: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.layout !== undefined, { message: 'Nothing to change' });
export type UpdateTemplateBody = z.infer<typeof updateTemplateBodySchema>;

/** Every field is written: an emptied field is sent `null` and clears, it is not dropped. */
export const profileBodySchema = z
  .object({
    name_ar: z.string().trim().min(1).max(120),
    name_en: optionalText(120),
    logo_media_id: z.number().int().positive().nullable(),
    tax_number: optionalText(40),
    commercial_register: optionalText(40),
  })
  .strict();
export type ProfileBody = z.infer<typeof profileBodySchema>;

export const labelsBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    /** A unit other than the base one prints the carton's own code and price. */
    items: z
      .array(
        z
          .object({
            variant_id: z.number().int().positive(),
            unit_id: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type LabelsBody = z.infer<typeof labelsBodySchema>;

// ── Wire ───────────────────────────────────────────────────────────────────

export interface WireTemplate {
  id: number;
  code: string | null;
  kind: DocumentKind;
  name: string;
  is_default: boolean;
  is_system: boolean;
  layout: Record<string, unknown>;
  updated_at: string;
}

export interface WireProfile {
  name_ar: string;
  name_en: string | null;
  logo: WireImage | null;
  tax_number: string | null;
  commercial_register: string | null;
  updated_at: string;
}

export interface WireDocumentBranch {
  id: number;
  name: string;
  address: string | null;
  contact_info: string | null;
}

/** Everything a device needs before it renders — one request, not four. */
export interface WireDocumentContext {
  profile: WireProfile;
  branch: WireDocumentBranch | null;
  /** The default of each kind; `null` only if someone deleted every one of that kind. */
  receipt_template: WireTemplate | null;
  label_template: WireTemplate | null;
  /** The print-order sticker (9-ز-3). */
  job_tag_template: WireTemplate | null;
}

export interface WireLabelItem {
  variant_id: number;
  product_id: number;
  unit_id: number;
  unit_name_ar: string;
  unit_factor: number;
  name_ar: string;
  name_en: string | null;
  /** «أزرق · A5» — empty for a product with one variant. */
  variant_label_ar: string;
  sku: string;
  /**
   * The code a scanner reads for this unit — a manufacturer's code before an
   * internal one (it is the one already on the goods). `null` when the unit
   * has none: the label then prints without a barcode rather than inventing one.
   */
  barcode: string | null;
  /**
   * The price at this branch, for this unit, after offers — as the till
   * charges it. `status` other than `priced` has no amount, and the label
   * says so rather than printing zero.
   */
  price: {
    status: 'priced' | 'unpriced' | 'not_listed';
    amount_syp: number | null;
    was_syp: number | null;
    promotion_names: string[];
  };
}
