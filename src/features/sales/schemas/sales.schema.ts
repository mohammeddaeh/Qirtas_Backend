import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { rolesTable } from '../../identity/schemas/roles.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { customersTable } from '../../customers/schemas/customers.schema.js';
import { catalogVariantsTable, catalogProductsTable } from '../../catalog/schemas/products.schema.js';
import { catalogUnitsTable } from '../../catalog/schemas/units.schema.js';

/**
 * نقطة البيع والفاتورة — `orders_delivery.md` §قرارات الفوترة 2026-09-22.
 *
 * **الفاتورة لقطة كاملة لا إشارة إلى الكتالوج.** اسم الصنف وسعره وخصمه
 * وضريبته وسعر الصرف كلها **مكتوبة بالسطر**: منتجٌ يُعاد تسميته أو يُرفع سعره
 * بعد شهر لا يغيّر فاتورةً طُبعت، وفاتورةٌ تُعيد قراءة الكتالوج تروي كل شهر
 * قصةً مختلفة عن اليوم نفسه.
 */

/**
 * - `open` — سلّة تُبنى، **بلا رقم فاتورة وبلا حجز مخزون**.
 * - `held` — مُعلَّقة: الكاشير انتقل لزبون آخر، والسلّة تنتظر بالخادم.
 * - `paid` — سُدِّدت، وهنا وحدها يُصرَف الرقم وتغادر البضاعة الرفّ.
 * - `void` — أُلغيت قبل السداد؛ لا رقم صُرف فلا فجوة.
 *
 * **والمدفوعة لا تُعدَّل ولا تُحذف** (§١): الإلغاء بمستندٍ معاكس (مرتجع/إشعار
 * دائن) يأتي بـ7-ج.
 */
export const saleStatusEnum = pgEnum('sale_status', ['open', 'held', 'paid', 'void']);

/**
 * `cash` نقد · `card` بطاقة · `customer_credit` من رصيد الزبون · `on_account`
 * آجل يُقيَّد ذمّةً عليه.
 *
 * **الأربعة بجدول منفصل لا عمود على الفاتورة**: فاتورةٌ تُسدَّد نصفها نقداً
 * ونصفها بطاقةً حالةٌ عادية بمحل، وعمودٌ واحد كان سيجبر الكاشير على الكذب.
 */
export const paymentMethodEnum = pgEnum('sale_payment_method', [
  'cash',
  'card',
  'customer_credit',
  'on_account',
]);

/** لماذا تحرّك رصيد الزبون — كل صفّ يقول سببه، وإلا صار الدفتر رقماً بلا قصة. */
export const ledgerReasonEnum = pgEnum('customer_ledger_reason', [
  'sale_on_account',
  'credit_spent',
  'refund_to_credit',
  'manual_adjustment',
]);

export const salesTable = pgTable(
  'sales',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    status: saleStatusEnum('status').notNull().default('open'),

    /**
     * `MZ-2026-000123` — **يُصرَف عند السداد وحده**.
     *
     * صرفُه عند فتح السلّة كان يعني رقماً لكل سلّة تُلغى، وتلك هي الفجوة
     * بعينها: مدقّقٌ يرى ٠٠٠١٢٢ ثم ٠٠٠١٢٤ لا يعرف أن الثالثة لم تكن بيعاً.
     */
    number: varchar('number', { length: 40 }),
    /** الجزء المتسلسل وحده — به يُعرف التالي بلا قراءة نصّ. */
    sequence: integer('sequence'),

    customer_id: integer('customer_id').references(() => customersTable.id, {
      onDelete: 'set null',
    }),
    /** اسم العابر بلا حساب — يُكتب ولا يُنشئ زبوناً. */
    customer_name: text('customer_name'),

    cashier_user_id: integer('cashier_user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),

    /**
     * خصم الكاشير على **الفاتورة كلّها** (§٦)، نسبةً. يُوزَّع على السطور عند
     * السداد ويُجمَّد بكلٍّ منها — والمرتجع يقرأ ما دُفع فعلاً لا السعر المعلن.
     */
    discount_percent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    /** السبب **إلزامي مع أي خصم** (§٦): «خصم ١٥٪» بلا سبب لا يُدقَّق. */
    discount_reason: text('discount_reason'),
    /**
     * من وافق على تجاوز سقف الكاشير — `null` حين كان الخصم داخل سقفه.
     * يُكتب بالفاتورة لا بسجلّ جانبي: «بموافقة من؟» سؤالٌ يُطرح على الفاتورة.
     */
    discount_approved_by: integer('discount_approved_by').references(() => usersTable.id, {
      onDelete: 'set null',
    }),

    /** المجاميع **مجمَّدة عند السداد** — احتسابها عند القراءة يجعل فاتورة أمس تتغيّر اليوم. */
    subtotal_syp: numeric('subtotal_syp', { precision: 14, scale: 2 }).notNull().default('0'),
    discount_syp: numeric('discount_syp', { precision: 14, scale: 2 }).notNull().default('0'),
    /** الضريبة **مستخرَجة من داخل السعر** (§١١): ما على الرف هو ما يُدفع. */
    tax_syp: numeric('tax_syp', { precision: 14, scale: 2 }).notNull().default('0'),
    total_syp: numeric('total_syp', { precision: 14, scale: 2 }).notNull().default('0'),

    /** سعر الصرف لحظة البيع — يُجمَّد فتُقرأ فاتورة الدولار بعد سنة كما صدرت. */
    usd_rate_syp: numeric('usd_rate_syp', { precision: 14, scale: 2 }),

    note: text('note'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paid_at: timestamp('paid_at', { withTimezone: true }),
    voided_at: timestamp('voided_at', { withTimezone: true }),
  },
  (table) => ({
    /** الرقم فريدٌ **بالفرع** لا بالنظام: كل فرع يعدّ من واحد. */
    numberOnce: uniqueIndex('sales_number_once').on(table.branch_id, table.number),
    branchIdx: index('sales_branch_idx').on(table.branch_id, table.status, table.created_at),
    cashierIdx: index('sales_cashier_idx').on(table.cashier_user_id, table.status),
  }),
);

export const saleLinesTable = pgTable(
  'sale_lines',
  {
    id: serial('id').primaryKey(),
    sale_id: integer('sale_id')
      .notNull()
      .references(() => salesTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    product_id: integer('product_id')
      .notNull()
      .references(() => catalogProductsTable.id, { onDelete: 'restrict' }),

    /**
     * الاسم **منسوخ** لا مقروء بانضمام: إعادة تسمية المنتج بعد شهر كانت ستغيّر
     * فاتورةً طُبعت، والزبون الذي يعود بها يقرأ صنفاً لم يشترِه.
     */
    name_ar: text('name_ar').notNull(),
    sku: varchar('sku', { length: 40 }).notNull(),

    /** الوحدة المُباع بها ومعاملها — «علبة ×١٢» تُقرأ بعد سنة بلا كتالوج. */
    unit_id: integer('unit_id').references(() => catalogUnitsTable.id, { onDelete: 'restrict' }),
    unit_name_ar: text('unit_name_ar'),
    unit_factor: numeric('unit_factor', { precision: 14, scale: 3 }).notNull().default('1'),

    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    /** سعر **الوحدة المُباع بها** كما عُرض، شاملاً الضريبة. */
    unit_price_syp: numeric('unit_price_syp', { precision: 14, scale: 2 }).notNull(),

    /** ما خفّضه عرضٌ قبل أن يصل الكاشير — ومعه اسمه، فالفاتورة تقول لماذا. */
    promotion_discount_syp: numeric('promotion_discount_syp', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    promotion_names: text('promotion_names'),

    /** حصّة هذا السطر من خصم الكاشير — تُوزَّع عند السداد وتُجمَّد. */
    manual_discount_syp: numeric('manual_discount_syp', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),

    /** النسبة المطبَّقة والمبلغ المستخرَج — لا يُعاد حسابهما من التصنيف لاحقاً. */
    tax_percent: numeric('tax_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    tax_syp: numeric('tax_syp', { precision: 14, scale: 2 }).notNull().default('0'),

    line_total_syp: numeric('line_total_syp', { precision: 14, scale: 2 }).notNull().default('0'),

    /** التكلفة لحظة البيع — بها يُحسب الربح بلا إعادة تشغيل الدفتر. */
    unit_cost_syp: numeric('unit_cost_syp', { precision: 14, scale: 2 }),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    saleIdx: index('sale_lines_sale_idx').on(table.sale_id),
    /**
     * صنفٌ واحد لكل (سلّة × متغيّر × وحدة): مسحُه مرتين **يزيد الكمية** ولا
     * يضيف سطراً — سطران بخمسة يفوّتان شريحة العشرة، ويقرأ الزبون صنفه مرتين.
     */
    once: uniqueIndex('sale_lines_once').on(table.sale_id, table.variant_id, table.unit_id),
  }),
);

export const salePaymentsTable = pgTable(
  'sale_payments',
  {
    id: serial('id').primaryKey(),
    sale_id: integer('sale_id')
      .notNull()
      .references(() => salesTable.id, { onDelete: 'cascade' }),
    method: paymentMethodEnum('method').notNull(),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    /** ما سلّمه الزبون نقداً — الباقي يُحسب منه، وكلاهما يُحفظ فالدرج يُطابَق. */
    tendered_syp: numeric('tendered_syp', { precision: 14, scale: 2 }),
    reference: text('reference'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    saleIdx: index('sale_payments_sale_idx').on(table.sale_id),
  }),
);

/**
 * التسلسل لكل (فرع × سنة) — **صفٌّ يُقفَل، لا `max(number)+1`**.
 *
 * قراءةُ الأكبر ثم الزيادة تعطي كاشيرين متزامنين الرقم نفسه، فيفشل أحدهما
 * بفهرس فريد بعد أن سلّم البضاعة. والقفل هنا يجعل الترقيم **بلا فجوات** فعلاً:
 * الرقم يُصرَف داخل معاملة السداد، وفشلها يُرجعه.
 */
export const saleSequencesTable = pgTable(
  'sale_sequences',
  {
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
    year: smallint('year').notNull(),
    last_sequence: integer('last_sequence').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branch_id, table.year] }),
  }),
);

/**
 * دفتر رصيد الزبون — **يُضاف إليه ولا يُعدَّل**، كدفتر المخزون.
 *
 * الرصيد مجموع صفوفه لا عمودٌ يُحدَّث: عمودٌ واحد يفقد «لماذا صار كذا»، وأول
 * خطأ فيه لا يُكتشف لأن لا شيء يُقارَن به.
 *
 * **والإشارة تحمل المعنى**: موجبٌ = للزبون عندنا رصيد · سالبٌ = علينا نطالبه
 * (آجل). دفتران منفصلان كانا سيسمحان بزبونٍ له رصيدٌ ودَينٌ معاً.
 */
export const customerLedgerTable = pgTable(
  'customer_ledger_entries',
  {
    id: serial('id').primaryKey(),
    customer_id: integer('customer_id')
      .notNull()
      .references(() => customersTable.id, { onDelete: 'restrict' }),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    reason: ledgerReasonEnum('reason').notNull(),
    sale_id: integer('sale_id').references(() => salesTable.id, { onDelete: 'set null' }),
    note: text('note'),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    customerIdx: index('customer_ledger_customer_idx').on(table.customer_id, table.created_at),
  }),
);

/**
 * سقف الآجل لكل زبون. **جدولٌ هنا لا عمودٌ على `customers`**: الذمّة قرار
 * مبيعات لا صفةٌ بالحساب، وموديول الزبائن لا يعرف عنها شيئاً (نفس سبب
 * `promotion_branch_caps`). والزبون بلا صفّ = **بلا آجل إطلاقاً**، وهي الحالة
 * الآمنة: سقفٌ افتراضي مفتوح يُقرض كل زبون بصمت.
 */
export const customerCreditLimitsTable = pgTable('customer_credit_limits', {
  customer_id: integer('customer_id')
    .primaryKey()
    .references(() => customersTable.id, { onDelete: 'cascade' }),
  limit_syp: numeric('limit_syp', { precision: 14, scale: 2 }).notNull(),
  updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * سقف الخصم اليدوي لكل دور (§٦) — **رقمٌ لا مفتاح صلاحية**: RBAC يجيب بنعم/لا،
 * و«كم تستطيع أن تخصم؟» سؤالٌ جوابه نسبة.
 *
 * وجدولٌ هنا لا عمودٌ على `roles` لأن موديول الهوية لا يعرف بيعاً — والدور بلا
 * صفّ = **صفر**، فكاشيرٌ جديد لا يخصم شيئاً حتى تقرّر الإدارة.
 */
export const roleDiscountCapsTable = pgTable('sale_role_discount_caps', {
  role_id: integer('role_id')
    .primaryKey()
    .references(() => rolesTable.id, { onDelete: 'cascade' }),
  max_discount_percent: numeric('max_discount_percent', { precision: 5, scale: 2 }).notNull(),
  /** هل يملك حامل هذا الدور أن **يوافق** على تجاوز غيره — لا أن يخصم فقط. */
  can_approve: boolean('can_approve').notNull().default(false),
  updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SaleRow = typeof salesTable.$inferSelect;
export type NewSaleRow = typeof salesTable.$inferInsert;
export type SaleLineRow = typeof saleLinesTable.$inferSelect;
export type SalePaymentRow = typeof salePaymentsTable.$inferSelect;
export type CustomerLedgerRow = typeof customerLedgerTable.$inferSelect;
