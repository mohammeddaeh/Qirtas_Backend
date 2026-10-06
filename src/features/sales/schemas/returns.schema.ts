import {
  boolean,
  index,
  integer,
  jsonb,
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
import { usersTable } from '../../identity/schemas/users.schema.js';
import { customersTable } from '../../customers/schemas/customers.schema.js';
import { catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { saleLinesTable, salesTable } from './sales.schema.js';

/**
 * المرتجع من الزبون — `orders_delivery.md` §٢.
 *
 * **يُربط بسطر الفاتورة الأصلية وبالسعر المدفوع فعلاً**، لا بالسعر الحالي: صنفٌ
 * اشتراه الزبون بعرضٍ انتهى يُرجَع بما دفعه، وإرجاعُه بسعر اليوم يُخرج من الدرج
 * أكثر مما دخله — والفرق لا يُكتشف إلا بجرد الصندوق.
 */

/**
 * نقدٌ من الدرج · أو قيدٌ موجب بدفتر الزبون.
 *
 * **والرصيد للمسمّى وحده** (قرار 2026-09-24): رصيدٌ لمن لا حساب له مالٌ لا يعود
 * إليه أبداً، والعابر يأخذ نقده ويمضي.
 */
export const refundMethodEnum = pgEnum('refund_method', ['cash', 'customer_credit']);

/**
 * حال القطعة الراجعة (قرار 2026-09-24) — **يقوله الكاشير وهي بيده**.
 *
 * `sellable` تعود للرفّ · `damaged` **لا تدخل الرصيد**: إدخالُ كل مرتجع يجعل
 * الدفتر يقول إن عندك قلماً مكسوراً جاهزاً للبيع، والجرد يكتشفه بعد شهر.
 */
export const returnConditionEnum = pgEnum('return_condition', ['sellable', 'damaged']);

export const saleReturnsTable = pgTable(
  'sale_returns',
  {
    id: serial('id').primaryKey(),

    /**
     * الفرع **المستلِم** لا البائع (§٢): الإرجاع بأي فرع، والبضاعة تدخل مخزون
     * من استلمها فعلاً — وإلا صار بالدفتر قلمٌ بفرعٍ لا وجود له فيه.
     */
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),

    /** الفاتورة الأصلية — **مصدر السعر والسقف معاً**. */
    sale_id: integer('sale_id')
      .notNull()
      .references(() => salesTable.id, { onDelete: 'restrict' }),

    /** `MZ-R-2026-000001` — تسلسلٌ **مستقل عن فواتير البيع**، فلا يقطع ترقيمها. */
    number: varchar('number', { length: 40 }).notNull(),
    sequence: integer('sequence').notNull(),

    customer_id: integer('customer_id').references(() => customersTable.id, {
      onDelete: 'set null',
    }),
    cashier_user_id: integer('cashier_user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),

    refund_method: refundMethodEnum('refund_method').notNull(),
    total_syp: numeric('total_syp', { precision: 14, scale: 2 }).notNull(),

    /**
     * أُرجِع **بعد المهلة** بموافقة مدير. يُحفظ بالصفّ لا يُشتقّ من التاريخين:
     * تغيير المهلة لاحقاً كان سيعيد تصنيف مرتجعات قديمة، فيقول تقريرٌ إن
     * استثناءً لم يحدث.
     */
    beyond_window: boolean('beyond_window').notNull().default(false),
    approved_by: integer('approved_by').references(() => usersTable.id, { onDelete: 'set null' }),

    reason: text('reason'),
    /** «لماذا» برمز تجمعه التقارير — مكرّر · خطأ المحل · غيّر رأيه · غير ذلك. */
    reason_code: varchar('reason_code', { length: 20 }),
    /** The return policy as it stood when this return was taken (`system_settings.md` principle 2). */
    policy: jsonb('policy'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    numberOnce: uniqueIndex('sale_returns_number_once').on(table.branch_id, table.number),
    saleIdx: index('sale_returns_sale_idx').on(table.sale_id),
    branchIdx: index('sale_returns_branch_idx').on(table.branch_id, table.created_at),
  }),
);

export const saleReturnLinesTable = pgTable(
  'sale_return_lines',
  {
    id: serial('id').primaryKey(),
    return_id: integer('return_id')
      .notNull()
      .references(() => saleReturnsTable.id, { onDelete: 'cascade' }),

    /** السطر الأصلي — به يُعرف ما دُفع فعلاً وكم بقي قابلاً للإرجاع. */
    sale_line_id: integer('sale_line_id')
      .notNull()
      .references(() => saleLinesTable.id, { onDelete: 'restrict' }),

    /** `null` لسطر خدمة (طباعة) — لا صنف يعود لرفّ المخزون (م-٢). */
    variant_id: integer('variant_id').references(() => catalogVariantsTable.id, {
      onDelete: 'restrict',
    }),

    /**
     * سطر خدمة راجع (`finance_ledger.md` §٣): نوعه ومرجعه كسطر البيع، و**مصيره**
     * — `ready` لرفّ الجاهز · `damaged` خسارة · `reprint` أُعيدت طباعته بلا ردّ.
     */
    service_kind: varchar('service_kind', { length: 20 }),
    service_ref_id: integer('service_ref_id'),
    disposition: varchar('disposition', { length: 12 }),

    /** منسوخان كسطر البيع: إيصالُ المرتجع يُقرأ بعد سنة بلا كتالوج. */
    name_ar: text('name_ar').notNull(),
    sku: varchar('sku', { length: 40 }).notNull(),

    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    /** **السعر المدفوع فعلاً للوحدة** — بعد العرض وبعد حصّة خصم الكاشير. */
    unit_refund_syp: numeric('unit_refund_syp', { precision: 14, scale: 2 }).notNull(),
    refund_syp: numeric('refund_syp', { precision: 14, scale: 2 }).notNull(),

    condition: returnConditionEnum('condition').notNull().default('sellable'),
    /** بوحدة الأساس — به تُحرَّك الأرصدة للصالح منها. */
    qty_base: numeric('qty_base', { precision: 14, scale: 3 }).notNull(),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    returnIdx: index('sale_return_lines_return_idx').on(table.return_id),
    lineIdx: index('sale_return_lines_line_idx').on(table.sale_line_id),
  }),
);

/** تسلسل المرتجعات لكل (فرع × سنة) — مستقلٌّ عن تسلسل البيع. */
export const returnSequencesTable = pgTable(
  'sale_return_sequences',
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
 * إعدادات البيع — **صفٌّ واحد** (`id = 1`).
 *
 * ومهلة الإرجاع **واحدة للشركة** (قرار 2026-09-24): مهلةٌ لكل فرع تجعل زبوناً
 * اشترى من فرع وأرجع لآخر يواجه قاعدتين، ولا يعرف أيّهما تخصّه.
 */
export const salesSettingsTable = pgTable('sales_settings', {
  id: integer('id').primaryKey().default(1),
  return_window_days: integer('return_window_days').notNull().default(14),
  /**
   * كم تبقى بضاعة الطلب محجوزة بانتظار صاحبها. **صفر = بلا مهلة** لا «تنتهي
   * فوراً»: الأولى قرارٌ إداري مفهوم، والثانية تُلغي كل طلب لحظة تأكيده.
   */
  reservation_hours: integer('reservation_hours').notNull().default(48),

  // ── Return policy (`system_settings.md`) — every default is today's behaviour.
  goods_returns_enabled: boolean('goods_returns_enabled').notNull().default(true),
  print_returns_enabled: boolean('print_returns_enabled').notNull().default(true),
  /** Past the window: `approve` (a manager on the same device) or `refuse`. */
  beyond_window_action: varchar('beyond_window_action', { length: 10 }).notNull().default('approve'),
  /** `null` = prints have no window (user decision 2026-10-04). */
  print_return_window_days: integer('print_return_window_days'),
  refund_cash_allowed: boolean('refund_cash_allowed').notNull().default(true),
  refund_credit_allowed: boolean('refund_credit_allowed').notNull().default(true),
  /** A return above this needs a manager. `null` = no cap. */
  approval_above_syp: numeric('approval_above_syp', { precision: 14, scale: 2 }),
  return_reason_required: boolean('return_reason_required').notNull().default(false),
  /** Damaged goods taken back (prints say their own fate per line). */
  damaged_returns_allowed: boolean('damaged_returns_allowed').notNull().default(true),
  /** The refund suggested for a returned print, as a share of what was paid. */
  print_refund_suggest_percent: integer('print_refund_suggest_percent').notNull().default(100),
  updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SaleReturnRow = typeof saleReturnsTable.$inferSelect;
export type SaleReturnLineRow = typeof saleReturnLinesTable.$inferSelect;
