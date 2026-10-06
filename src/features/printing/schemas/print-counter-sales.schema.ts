import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { salesTable } from '../../sales/schemas/sales.schema.js';
import { printOptionsTable } from './printing.schema.js';

/**
 * بيع الطباعة المباشر بالصندوق — الشريحة 9-و (`printing_system.md` §خطة 9-و).
 *
 * **ليس طلب طباعة**: لا زبون ولا ملف ولا طابور ولا رقم — قرار المستخدم
 * (2026-10-04): الزبون واقف، يُطبع له ويدفع. الصفّ موجود لسببين لا ثالث:
 * سطر الخدمة بالفاتورة يحتاج مرجعاً، وخصم المواد يحتاج ما يُنسب إليه.
 *
 * `open` حين يُسعَّر ← `settled` بسداد الفاتورة (وتُخصم المواد بمعاملتها) أو
 * `void` بحذف السطر أو إلغاء السلّة (لا يُخصم شيء).
 */
export const PRINT_COUNTER_STATUSES = ['open', 'settled', 'void'] as const;
export type PrintCounterStatus = (typeof PRINT_COUNTER_STATUSES)[number];
export const printCounterStatusEnum = pgEnum('print_counter_status', PRINT_COUNTER_STATUSES);

export const printCounterSalesTable = pgTable(
  'print_counter_sales',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    status: printCounterStatusEnum('status').notNull().default('open'),
    sale_id: integer('sale_id').references(() => salesTable.id, { onDelete: 'set null' }),
    paper_size_id: integer('paper_size_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    color_mode_id: integer('color_mode_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    sides_id: integer('sides_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    binding_id: integer('binding_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    cover_id: integer('cover_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    /** اسم المطبوع (اختياري) — يظهر بسطر الفاتورة وبه يُطابَق رفّ الجاهز (م-٢). */
    label: varchar('label', { length: 120 }),
    pages: integer('pages').notNull(),
    copies: integer('copies').notNull(),
    /** لقطة التسعير كما أرجعها `priceJob` — الفاتورة تُقبض بها ولو تغيّر الجدول بعدها. */
    quote: jsonb('quote').notNull(),
    total_syp: numeric('total_syp', { precision: 14, scale: 2 }).notNull(),
    /** تكلفة المواد المخصومة عند السداد — `null` قبله. */
    materials_cost_syp: numeric('materials_cost_syp', { precision: 14, scale: 2 }),
    created_by: integer('created_by').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settled_at: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => ({
    saleIdx: index('print_counter_sales_sale_idx').on(table.sale_id),
    branchIdx: index('print_counter_sales_branch_idx').on(table.branch_id, table.created_at),
  }),
);

export type PrintCounterSaleRow = typeof printCounterSalesTable.$inferSelect;
