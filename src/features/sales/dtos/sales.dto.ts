import { z } from 'zod';
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

export const payBodySchema = z
  .object({ payments: z.array(paymentSchema).min(1).max(5) })
  .strict();

export const salesQuerySchema = paginationQuerySchema
  .extend({
    branch_id: id.optional(),
    cashier_id: id.optional(),
    status: z.enum(['open', 'held', 'paid', 'void']).optional(),
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

export const createReturnBodySchema = z
  .object({
    /** الفرع **المستلِم** لا البائع: الإرجاع بأي فرع (§٢). */
    branch_id: id,
    sale_id: id,
    lines: z.array(returnLineSchema).min(1).max(50),
    refund_method: z.enum(['cash', 'customer_credit']),
    reason: z.string().trim().max(300).nullable().optional(),
    approver_user_id: id.nullable().optional(),
  })
  .strict();

/** موافقة المدير على تجاوز المهلة — بنفس جهاز الكاشير، ولا جلسة تُفتح. */
export const approveReturnBodySchema = createReturnBodySchema
  .omit({ approver_user_id: true })
  .extend({
    email: z.string().trim().email(),
    password: z.string().min(1).max(200),
  })
  .strict();

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
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Nothing to change',
  });

export type CreateReturnBody = z.infer<typeof createReturnBodySchema>;
export type PayBody = z.infer<typeof payBodySchema>;
export type DiscountBody = z.infer<typeof discountBodySchema>;
export type SalesQuery = z.infer<typeof salesQuerySchema>;
