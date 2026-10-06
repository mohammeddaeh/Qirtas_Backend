import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { salesTable } from '../../sales/schemas/sales.schema.js';
import { printOptionsTable } from './printing.schema.js';

/**
 * رفّ الجاهز — `finance_ledger.md` §٤ (م-٢).
 *
 * مطبوعٌ راجع صالح يُحفظ **باسمه ورقمه** (`J-0012`) لا صنفاً بالكتالوج (قرار
 * المستخدم 2026-10-04): يُنبَّه عليه حين يُطلب الاسم نفسه، ويُباع ثانيةً بسعر
 * حرّ، وإن لم يُبع يُشطب خسارة. **الورق لا يعود للمخزون** — طُبع فعلاً؛
 * النسخة قيمتها تكلفة موادها (`unit_value_syp`) لا رزمةٌ على الرفّ.
 */
export const PRINT_READY_STATUSES = ['available', 'sold_out', 'written_off'] as const;
export type PrintReadyStatus = (typeof PRINT_READY_STATUSES)[number];
export const printReadyStatusEnum = pgEnum('print_ready_status', PRINT_READY_STATUSES);

export const printReadyCopiesTable = pgTable(
  'print_ready_copies',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    label: varchar('label', { length: 120 }).notNull(),
    /** `MZ-J-0004` from central numbering; older rows carry `J-<id>` (backfilled). */
    number: varchar('number', { length: 40 }),
    status: printReadyStatusEnum('status').notNull().default('available'),
    paper_size_id: integer('paper_size_id').references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    color_mode_id: integer('color_mode_id').references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    sides_id: integer('sides_id').references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    binding_id: integer('binding_id').references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    cover_id: integer('cover_id').references(() => printOptionsTable.id, { onDelete: 'restrict' }),
    pages: integer('pages'),
    copies_in: integer('copies_in').notNull(),
    copies_available: integer('copies_available').notNull(),
    /** تكلفة مواد النسخة — قيمتها بالرفّ، وتكلفتها حين تُباع أو تُشطب. */
    unit_value_syp: numeric('unit_value_syp', { precision: 14, scale: 2 }).notNull(),
    /** ما دُفع للنسخة أول مرة — السعر المقترح لإعادة البيع (الكاشير حرّ). */
    unit_price_syp: numeric('unit_price_syp', { precision: 14, scale: 2 }).notNull(),
    /** «من أين»: المرتجع والفاتورة الأصل. */
    source_return_id: integer('source_return_id'),
    source_sale_id: integer('source_sale_id'),
    created_by: integer('created_by').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    branchIdx: index('print_ready_copies_branch_idx').on(table.branch_id, table.status),
  }),
);

/** بيعٌ من الجاهز بانتظار السداد — سطر خدمة `print_ready` (كالبيع المباشر). */
export const printReadySalesTable = pgTable(
  'print_ready_sales',
  {
    id: serial('id').primaryKey(),
    ready_copy_id: integer('ready_copy_id')
      .notNull()
      .references(() => printReadyCopiesTable.id, { onDelete: 'restrict' }),
    branch_id: integer('branch_id').notNull(),
    status: varchar('status', { length: 10 }).notNull().default('open'),
    sale_id: integer('sale_id').references(() => salesTable.id, { onDelete: 'set null' }),
    copies: integer('copies').notNull(),
    unit_price_syp: numeric('unit_price_syp', { precision: 14, scale: 2 }).notNull(),
    total_syp: numeric('total_syp', { precision: 14, scale: 2 }).notNull(),
    created_by: integer('created_by'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settled_at: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => ({
    copyIdx: index('print_ready_sales_copy_idx').on(table.ready_copy_id),
  }),
);

/** شطب نسخ من الجاهز — «لماذا ومتى ومن»، والخسارة بقيدها. */
export const printReadyWriteOffsTable = pgTable('print_ready_write_offs', {
  id: serial('id').primaryKey(),
  ready_copy_id: integer('ready_copy_id')
    .notNull()
    .references(() => printReadyCopiesTable.id, { onDelete: 'restrict' }),
  copies: integer('copies').notNull(),
  value_syp: numeric('value_syp', { precision: 14, scale: 2 }).notNull(),
  reason_code: varchar('reason_code', { length: 20 }).notNull(),
  note: text('note'),
  created_by: integer('created_by'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PrintReadyCopyRow = typeof printReadyCopiesTable.$inferSelect;
export type PrintReadySaleRow = typeof printReadySalesTable.$inferSelect;
