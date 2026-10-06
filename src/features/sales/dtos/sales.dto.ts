import { z } from 'zod';
import { SERVICE_KINDS } from '../../../core/till/service-line-port.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';

/** نقطة البيع — `qirtas_backend/docs/rest_api.md` §27. */

const id = z.coerce.number().int().positive();
const money = z.number().min(0);

export const openSaleBodySchema = z
  .object({
    branch_id: id,
    customer_id: id.nullable().optional(),
    /** العابر بلا حساب يُكتب اسمه ولا يُنشأ له زبون. */
    customer_name: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

export const addLineBodySchema = z
  .object({
    variant_id: id,
    qty: z.number().positive().max(100000),
    unit_id: id.nullable().optional(),
  })
  .strict();

/**
 * خدمةٌ للسلّة بمرجعها كما يقرؤه الزبون — رقم طلب الطباعة (`BR1-P-2026-000001`)
 * أو معرّفه. **بلا مبلغ**: المبلغ من الموديول المالك لا من الجهاز.
 */
export const addServiceBodySchema = z
  .object({
    kind: z.enum(SERVICE_KINDS),
    reference: z.string().trim().min(1).max(40),
    /**
     * It sits on another open invoice (a basket left open, a second till) —
     * move it here: the line leaves that invoice in the same transaction.
     */
    take_over: z.boolean().optional(),
  })
  .strict();

export type AddServiceBody = z.infer<typeof addServiceBodySchema>;

export const lineQtyBodySchema = z.object({ qty: z.number().min(0).max(100000) }).strict();

export const heldBodySchema = z.object({ held: z.boolean() }).strict();

/**
 * الخصم — **والسبب حقلٌ إلزامي حين تكون النسبة فوق صفر** (يفرضه الخادم بعد
 * القراءة: شرطٌ بـzod وحده كان سيقول «بيانات غير صالحة» بدل تسمية الحقل).
 *
 * و`approver_user_id` لا يُرسَل من الجهاز مباشرةً: يمرّ عبر
 * `POST /sales/:id/discount/approve` الذي يتحقّق من كلمة مرور الموافق.
 */
export const discountBodySchema = z
  .object({
    percent: z.number().min(0).max(100),
    reason: z.string().trim().max(300).default(''),
    approver_user_id: id.nullable().optional(),
  })
  .strict();

/** موافقة المدير **بنفس الجهاز**: بريده وكلمة مروره، ولا توكن ثانٍ يُفتح. */
export const approveDiscountBodySchema = z
  .object({
    percent: z.number().min(0).max(100),
    /**
     * السبب يسافر مع الموافقة، **وإلا كان المسار ميتاً**: الخدمة تشترط سبباً مع
     * أي خصم فوق صفر، وجسمٌ `.strict()` يرفض الحقل يجعل كل موافقة تفشل —
     * بـ422 عن «مفتاح غير معروف» لا عن السبب الناقص. اكتُشف بالتجريب الحيّ.
     */
    reason: z.string().trim().max(300).default(''),
    email: z.string().trim().email(),
    password: z.string().min(1).max(200),
  })
  .strict();

export const paymentSchema = z
  .object({
    method: z.enum(['cash', 'card', 'customer_credit', 'on_account']),
    amount_syp: money,
    /** ما سلّمه الزبون نقداً — الباقي يُحسب منه. */
    tendered_syp: money.nullable().optional(),
    reference: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

export const payBodySchema = z.object({ payments: z.array(paymentSchema).min(1).max(5) }).strict();

export const salesQuerySchema = paginationQuerySchema
  .extend({
    branch_id: id.optional(),
    cashier_id: id.optional(),
    status: z.enum(['open', 'held', 'paid', 'void']).optional(),
    // سجلّ المبيعات: رقم الفاتورة أو اسم الزبون جزئياً، ونطاق أيامٍ كاملة.
    search: z.string().trim().min(1).max(64).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

export const openSalesQuerySchema = z.object({ branch_id: id }).strict();

/** بحث أصناف الكاشير: فرعٌ إلزامي (السعر والرصيد عن مكان) ونصٌّ أو رمز. */
export const sellableItemsQuerySchema = z
  .object({ branch_id: id, search: z.string().trim().min(1).max(100) })
  .strict();

export const discountCheckQuerySchema = z
  .object({ percent: z.coerce.number().min(0).max(100) })
  .strict();

export const capBodySchema = z
  .object({
    role_id: id,
    max_discount_percent: z.number().min(0).max(100),
    can_approve: z.boolean().default(false),
  })
  .strict();

export const creditLimitBodySchema = z.object({ limit_syp: money }).strict();

export const ledgerBodySchema = z
  .object({
    /** موجبٌ إيداع رصيد · سالبٌ تحميل ذمّة — والإشارة هي المعنى. */
    amount_syp: z.number(),
    note: z.string().trim().max(300).default(''),
  })
  .strict();

// ── المرتجع (§٢) ────────────────────────────────────────────────────────────

const returnLineSchema = z
  .object({
    sale_line_id: id,
    qty: z.number().positive().max(100000),
    /** حال القطعة **وهي بيد الكاشير** — لا فحصٌ لاحق ينساه أحد. */
    condition: z.enum(['sellable', 'damaged']).default('sellable'),
  })
  .strict();

/** A print line coming back (`finance_ledger.md` §٣). */
const serviceReturnLineSchema = z
  .object({
    sale_line_id: id,
    copies: z.number().int().positive().max(100000),
    /** The cashier's amount — the server caps it at what is left. */
    refund_syp: z.number().min(0).max(100_000_000),
    disposition: z.enum(['ready', 'damaged', 'reprint']),
    /** The ready-shelf name — defaults to the print's own label. */
    label: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

export const RETURN_REASON_CODES = ['duplicate', 'shop_error', 'changed_mind', 'other'] as const;

const createReturnBodyBase = z
  .object({
    /** الفرع **المستلِم** لا البائع: الإرجاع بأي فرع (§٢). */
    branch_id: id,
    sale_id: id,
    lines: z.array(returnLineSchema).max(50).default([]),
    service_lines: z.array(serviceReturnLineSchema).max(50).default([]),
    refund_method: z.enum(['cash', 'customer_credit']),
    reason: z.string().trim().max(300).nullable().optional(),
    reason_code: z.enum(RETURN_REASON_CODES).nullable().optional(),
    approver_user_id: id.nullable().optional(),
  })
  .strict();

const hasLines = (b: { lines: unknown[]; service_lines: unknown[] }) =>
  b.lines.length + b.service_lines.length > 0;

export const createReturnBodySchema = createReturnBodyBase.refine(hasLines, {
    message: 'A return needs at least one line',
    path: ['lines'],
  });

/** موافقة المدير على تجاوز المهلة — بنفس جهاز الكاشير، ولا جلسة تُفتح. */
export const approveReturnBodySchema = createReturnBodyBase
  .omit({ approver_user_id: true })
  .extend({
    email: z.string().trim().email(),
    password: z.string().min(1).max(200),
  })
  .strict()
  .refine(hasLines, { message: 'A return needs at least one line', path: ['lines'] });

export const returnsQuerySchema = paginationQuerySchema
  .extend({ branch_id: id.optional(), sale_id: id.optional() })
  .strict();

/**
 * إعدادات البيع — **والحقلان اختياريان**.
 *
 * شاشتان تكتبان هذا الصفّ (مهلة الإرجاع ومهلة حجز الطلب)، وإلزامُ الاثنين
 * يجعل كل شاشة ترسل قيمةً لا تعرض سببها — فتدهس تعديل الأخرى بصمت.
 */
export const salesSettingsBodySchema = z
  .object({
    /** صفرٌ = لا إرجاع إطلاقاً — قرارٌ مشروع، لكنه يُكتب صراحةً. */
    return_window_days: z.number().int().min(0).max(365).optional(),
    /** صفرٌ = حجزٌ بلا مهلة، لا «تنتهي فوراً». */
    reservation_hours: z.number().int().min(0).max(720).optional(),
    // ── سياسة المرتجع (`system_settings.md`) ──
    goods_returns_enabled: z.boolean().optional(),
    print_returns_enabled: z.boolean().optional(),
    beyond_window_action: z.enum(['approve', 'refuse']).optional(),
    /** `null` = المطبوعات بلا مهلة. */
    print_return_window_days: z.number().int().min(0).max(365).nullable().optional(),
    refund_cash_allowed: z.boolean().optional(),
    refund_credit_allowed: z.boolean().optional(),
    /** `null` = بلا سقف. */
    approval_above_syp: z.number().min(0).max(1_000_000_000).nullable().optional(),
    return_reason_required: z.boolean().optional(),
    damaged_returns_allowed: z.boolean().optional(),
    print_refund_suggest_percent: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Nothing to change',
  });

export type CreateReturnBody = z.infer<typeof createReturnBodySchema>;
export type PayBody = z.infer<typeof payBodySchema>;
export type DiscountBody = z.infer<typeof discountBodySchema>;
export type SalesQuery = z.infer<typeof salesQuerySchema>;
