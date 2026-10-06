import { z } from 'zod';
import { PRINT_OPTION_KINDS } from '../schemas/printing.schema.js';

/** إعداد الطباعة وتسعيرها — `printing_system.md` §قرارات التنفيذ، `rest_api.md` §29. */

const id = z.coerce.number().int().positive();
const money = z.number().min(0).max(100_000_000);
const percent = z.number().min(0).max(100);

export const printOptionKindSchema = z.enum(PRINT_OPTION_KINDS);

export const branchQuerySchema = z.object({ branch_id: id }).strict();

export const configQuerySchema = z.object({ branch_id: id.optional() }).strict();

export const branchParamsSchema = z.object({ branchId: id }).strict();

/**
 * المواصفة كاملة، والأبعاد الخمسة إلزامية — «بلا تجليد» خيارٌ يُختار لا حقلٌ
 * يُترك (`printing.schema.ts`).
 */
export const quoteBodySchema = z
  .object({
    branch_id: id,
    pages: z.number().int().min(1).max(100_000),
    copies: z.number().int().min(1).max(10_000),
    paper_size_id: id,
    color_mode_id: id,
    sides_id: id,
    binding_id: id,
    cover_id: id,
  })
  .strict();

/** بيعٌ مباشر بالصندوق (9-و) — التسعير نفسه، و**اسم المطبوع** اختياري (م-٢). */
/**
 * A print for the customer at the till (9-ح-1) — **for someone**: a registered
 * customer, a name typed at the counter (with an optional phone), or a
 * walk-in said so explicitly. Every print reaches the record and the reports.
 */
export const counterSaleBodySchema = quoteBodySchema
  .extend({
    label: z.string().trim().max(120).nullable().optional(),
    customer_id: z.number().int().positive().nullable().optional(),
    contact_name: z.string().trim().min(2).max(120).nullable().optional(),
    contact_phone: z.string().trim().max(32).nullable().optional(),
    walk_in: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.customer_id != null || (b.contact_name?.length ?? 0) >= 2 || b.walk_in === true, {
    message: 'Say who the print is for — a customer, a name, or a walk-in',
    path: ['contact_name'],
  });

export const contactsQuerySchema = z.object({ q: z.string().trim().min(2).max(80) }).strict();

/** بيعٌ من رفّ الجاهز — **السعر حرّ** (قرار المستخدم)، والعدد ضمن المتاح. */
export const readySaleBodySchema = z
  .object({
    copies: z.number().int().min(1).max(10_000),
    unit_price_syp: z.number().min(0).max(100_000_000),
  })
  .strict();

export const READY_WRITE_OFF_REASONS = ['season_over', 'damaged_on_shelf', 'other'] as const;

export const readyWriteOffBodySchema = z
  .object({
    copies: z.number().int().min(1).max(10_000),
    reason_code: z.enum(READY_WRITE_OFF_REASONS),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export const readyCopiesQuerySchema = z
  .object({
    branch_id: z.coerce.number().int().positive(),
    search: z.string().trim().min(1).max(120).optional(),
    // `z.coerce.boolean()` reads "false" as true — the string is matched instead.
    include_closed: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strict();

/** الرمز معرّفٌ يقرؤه الكود — حروف لاتينية صغيرة وأرقام وشرطة سفلية. */
export const createOptionBodySchema = z
  .object({
    kind: printOptionKindSchema,
    code: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{1,32}$/),
    name_ar: z.string().trim().min(1).max(80),
    name_en: z.string().trim().max(80).nullable().optional(),
    sort_order: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

/** الرمز والنوع ليسا هنا عمداً — راجع `printing.service.ts` `updateOption`. */
export const updateOptionBodySchema = z
  .object({
    name_ar: z.string().trim().min(1).max(80).optional(),
    name_en: z.string().trim().max(80).nullable().optional(),
    sort_order: z.number().int().min(0).max(10_000).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const pageCellSchema = z
  .object({
    paper_size_id: id,
    color_mode_id: id,
    sides_id: id,
    /** `null` يحذف الخلية — وغياب الخلية عن الطلب يُبقيها كما هي. */
    amount_syp: money.nullable(),
  })
  .strict();

const finishingCellSchema = z.object({ option_id: id, amount_syp: money.nullable() }).strict();

export const ratesBodySchema = z
  .object({
    page_rates: z.array(pageCellSchema).max(500).default([]),
    finishing_rates: z.array(finishingCellSchema).max(200).default([]),
  })
  .strict();

export const tiersBodySchema = z
  .object({
    tiers: z
      .array(z.object({ min_pages: z.number().int().min(1), discount_percent: percent }).strict())
      .max(20),
  })
  .strict();

export const settingsBodySchema = z
  .object({
    branch_band_percent: percent.optional(),
    file_retention_days: z.number().int().min(1).max(3650).optional(),
    max_file_mb: z.number().int().min(1).max(500).optional(),
    max_pages: z.number().int().min(1).max(100_000).optional(),
    /** صفرٌ = بلا مهلة (`job-rules.ts` `paymentDeadline`). */
    unpaid_timeout_days: z.number().int().min(0).max(90).optional(),
    ready_stale_days: z.number().int().min(1).max(365).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const branchOptionsBodySchema = z
  .object({
    options: z
      .array(z.object({ option_id: id, is_enabled: z.boolean() }).strict())
      .min(1)
      .max(200),
  })
  .strict();

export type QuoteBody = z.infer<typeof quoteBodySchema>;
export type CreateOptionBody = z.infer<typeof createOptionBodySchema>;
export type UpdateOptionBody = z.infer<typeof updateOptionBodySchema>;
export type RatesBody = z.infer<typeof ratesBodySchema>;
export type TiersBody = z.infer<typeof tiersBodySchema>;
export type SettingsBody = z.infer<typeof settingsBodySchema>;
export type BranchOptionsBody = z.infer<typeof branchOptionsBodySchema>;
export type CounterSaleBody = z.infer<typeof counterSaleBodySchema>;
export type ReadySaleBody = z.infer<typeof readySaleBodySchema>;
export type ReadyWriteOffBody = z.infer<typeof readyWriteOffBodySchema>;
export type ReadyCopiesQuery = z.infer<typeof readyCopiesQuerySchema>;
