import { index, integer, numeric, pgEnum, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * السجل المالي — `docs/reference/finance_ledger.md` §٢.
 *
 * **كل حدثٍ يحرّك مالاً أو قيمة يكتب قيداً هنا بنفس معاملته**، والتقارير تجمع
 * القيود ولا تعيد الحساب من الجداول التشغيلية: حسابان لنفس الرقم يختلفان أول
 * تعديل، وبلا أي فشل.
 *
 * بـ`core/` لا بموديول: البيع والمخزون والطباعة كلها تكتب فيه، ولا موديول
 * يستورد آخر. ولا مفاتيح أجنبية إلى جداول الموديولات لنفس السبب — المستند
 * يُشار إليه بنوعه ومعرّفه.
 *
 * **الإشارة تحمل المعنى**: موجبٌ = داخل/قيمة تُكسب، سالبٌ = خارج/كلفة/خسارة.
 * فصافي أي مجموعة قيود هو جمعها، بلا جدول يقول أيّها يُطرح.
 */
export const FINANCE_ENTRY_TYPES = [
  // البيع
  'sale_revenue',
  'cogs',
  'print_materials',
  // المرتجع
  'refund',
  'cogs_reversal',
  'loss_damaged_return',
  // الطباعة الراجعة ورفّ الجاهز (م-٢)
  'loss_print_return',
  'print_waste',
  'ready_shelf_in',
  'ready_shelf_out',
  'loss_ready_writeoff',
  // المخزون
  'loss_inventory',
] as const;
export type FinanceEntryType = (typeof FINANCE_ENTRY_TYPES)[number];
export const financeEntryTypeEnum = pgEnum('finance_entry_type', FINANCE_ENTRY_TYPES);

/** كيف تحرّك المال — و`value` لقيمةٍ لا نقد فيها (تكلفة · خسارة · رفّ). */
export const FINANCE_METHODS = ['cash', 'card', 'customer_credit', 'on_account', 'value'] as const;
export type FinanceMethod = (typeof FINANCE_METHODS)[number];
export const financeMethodEnum = pgEnum('finance_method', FINANCE_METHODS);

export const FINANCE_DOC_TYPES = [
  'sale',
  'sale_return',
  'stock_adjustment',
  'print_job',
  'print_counter',
  'ready_copy',
] as const;
export type FinanceDocType = (typeof FINANCE_DOC_TYPES)[number];
export const financeDocTypeEnum = pgEnum('finance_doc_type', FINANCE_DOC_TYPES);

export const financeEntriesTable = pgTable(
  'finance_entries',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id').notNull(),
    type: financeEntryTypeEnum('type').notNull(),
    method: financeMethodEnum('method').notNull(),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    doc_type: financeDocTypeEnum('doc_type').notNull(),
    doc_id: integer('doc_id').notNull(),
    /** الفاتورة التي يعود إليها القيد — للربط بالتقارير («من أين»). */
    sale_id: integer('sale_id'),
    /** من أحدثه — الكاشير أو موظف المخزون. */
    user_id: integer('user_id'),
    /** «لماذا» — سبب المرتجع أو التلف، رمزٌ تُترجمه الواجهة. */
    reason: varchar('reason', { length: 40 }),
    note: text('note'),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    branchTimeIdx: index('finance_entries_branch_time_idx').on(table.branch_id, table.occurred_at),
    typeTimeIdx: index('finance_entries_type_time_idx').on(table.type, table.occurred_at),
    docIdx: index('finance_entries_doc_idx').on(table.doc_type, table.doc_id),
    saleIdx: index('finance_entries_sale_idx').on(table.sale_id),
  }),
);

export type FinanceEntryRow = typeof financeEntriesTable.$inferSelect;
