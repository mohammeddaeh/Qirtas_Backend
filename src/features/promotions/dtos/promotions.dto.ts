import { z } from 'zod';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';

/** العروض — `store_system.md` §٥، `rest_api.md` §26. */

const id = z.coerce.number().int().positive();
const percent = z.number().min(0).max(100);
const money = z.number().min(0);

export const promotionScopeSchema = z.enum(['all_branches', 'branches']);
export const promotionTargetSchema = z.enum(['variant', 'product', 'category', 'brand']);
export const promotionKindSchema = z.enum(['percent', 'amount', 'buy_x_get_y', 'qty_tiers']);
export const promotionChannelSchema = z.enum(['online', 'pos', 'both']);
export const promotionSegmentSchema = z.enum(['retail', 'wholesale', 'all']);
export const promotionStatusSchema = z.enum(['live', 'scheduled', 'ended', 'inactive', 'archived']);

export const promotionsQuerySchema = paginationQuerySchema
  .extend({
    search: z.string().trim().min(1).max(100).optional(),
    branch_id: id.optional(),
    kind: promotionKindSchema.optional(),
    status: promotionStatusSchema.optional(),
    /** الأرشيف كتالوج ثانٍ لا حالة — وسقوطه من الاستعلام يُرجع الحيّ بمكانه. */
    archived: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => v === true || v === 'true')
      .optional(),
  })
  .strict();

const tierSchema = z
  .object({
    min_qty: z.number().int().positive(),
    percent_value: percent.nullable().optional(),
    amount_syp: money.nullable().optional(),
  })
  .strict();

/**
 * الحقول كلها بكل كتابة (لا `PATCH` جزئي): العرض **مجموعة قواعد تُقرأ معاً**،
 * وتعديل نوعه بلا قيمه يترك نسبة عرضٍ قديم على عرض مبلغ. والحقل المُفرَّغ
 * يُرسَل `null` فيُمحى، ولا يُحذف من الجسم فيبقى القديم بصمت.
 */
export const promotionBodySchema = z
  .object({
    name_ar: z.string().trim().min(1).max(160),
    name_en: z.string().trim().max(160).nullable().optional(),
    scope: promotionScopeSchema,
    branch_ids: z.array(id).max(100).optional(),
    target_kind: promotionTargetSchema,
    target_id: id,
    kind: promotionKindSchema,
    percent_value: percent.nullable().optional(),
    amount_syp: money.nullable().optional(),
    buy_qty: z.number().int().positive().nullable().optional(),
    get_qty: z.number().int().positive().nullable().optional(),
    get_percent: percent.nullable().optional(),
    tiers: z.array(tierSchema).max(20).optional(),
    starts_at: z.string().datetime().nullable().optional(),
    ends_at: z.string().datetime().nullable().optional(),
    channel: promotionChannelSchema.default('both'),
    segment: promotionSegmentSchema.default('all'),
    is_stackable: z.boolean().default(false),
    is_active: z.boolean().default(true),
  })
  .strict()
  .refine(
    (b) => b.starts_at === null || b.ends_at === null || !b.starts_at || !b.ends_at || b.ends_at > b.starts_at,
    { message: 'The promotion must end after it starts', path: ['ends_at'] },
  );

export const archiveBodySchema = z.object({ archived: z.boolean() }).strict();

export const capBodySchema = z
  .object({ branch_id: id, max_discount_percent: percent })
  .strict();

export const previewBodySchema = z
  .object({
    branch_id: id,
    channel: z.enum(['online', 'pos']).default('online'),
    segment: z.enum(['retail', 'wholesale']).default('retail'),
    lines: z
      .array(z.object({ variant_id: id, qty: z.number().int().positive().max(9999) }).strict())
      .min(1)
      .max(50),
  })
  .strict();

export type PromotionsQuery = z.infer<typeof promotionsQuerySchema>;
export type PromotionBody = z.infer<typeof promotionBodySchema>;
export type PreviewBody = z.infer<typeof previewBodySchema>;
