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
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';

/**
 * إعداد الطباعة وتسعيرها — الشريحة 9-أ (`docs/reference/printing_system.md`
 * §قرارات التنفيذ).
 *
 * **خمسة أبعاد للمواصفة، وكلها إلزامية بالطلب**: المقاس · اللون · الوجه ·
 * التجليد · الغلاف. «بلا تجليد» و«بلا غلاف» خياران مبذوران بسعر صفر لا
 * غيابٌ للقيمة — طلبٌ بلا تجليد يقول ذلك صراحةً، وطلبٌ نسي التجليد لا يُقبل.
 */
export const PRINT_OPTION_KINDS = [
  'paper_size',
  'color_mode',
  'sides',
  'binding',
  'cover',
] as const;
export type PrintOptionKind = (typeof PRINT_OPTION_KINDS)[number];
export const printOptionKindEnum = pgEnum('print_option_kind', PRINT_OPTION_KINDS);

/**
 * خيارات المواصفة. **`code` معرّفٌ ثابت** (`a4` · `color` · `double` · `spiral`)
 * يقرؤه الكود حيث يحتاج معنىً (الوجهان يطبعان صفحتين على الورقة)، والاسمان
 * للعرض ويُعدَّلان بحرية.
 *
 * **ولا حذف**: خيارٌ استُعمل بطلبٍ سابق يبقى ليُحلّ اسمه؛ يُعطَّل (`is_active`)
 * فيختفي من كل منتقٍ ويبقى السجل صادقاً.
 */
export const printOptionsTable = pgTable(
  'print_options',
  {
    id: serial('id').primaryKey(),
    kind: printOptionKindEnum('kind').notNull(),
    code: varchar('code', { length: 32 }).notNull(),
    name_ar: varchar('name_ar', { length: 80 }).notNull(),
    name_en: varchar('name_en', { length: 80 }),
    sort_order: integer('sort_order').notNull().default(0),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kindCode: unique('print_options_kind_code_uq').on(table.kind, table.code),
  }),
);

/**
 * سعر **الصفحة المطبوعة** لكل (مقاس × لون × وجه) — مركزي.
 *
 * الصفحة وجهٌ مطبوع لا ورقة: ٢٠ صفحة بوجهين عشر ورقات، والسعر لكل صفحة
 * لأن هذا ما يعدّه الزبون بملفّه. والوجهان يُسعَّران بصفّهما (عادةً أرخص
 * للصفحة) لا بخصمٍ على الوجه الواحد — قاعدةٌ مشتقّة تختلف عمّا يكتبه
 * المحلّ على لوحته.
 */
export const printPageRatesTable = pgTable(
  'print_page_rates',
  {
    paper_size_id: integer('paper_size_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
    color_mode_id: integer('color_mode_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
    sides_id: integer('sides_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.paper_size_id, table.color_mode_id, table.sides_id] }),
  }),
);

/** سعر التشطيب (تجليد · غلاف) **لكل نسخة** — مركزي. */
export const printFinishingRatesTable = pgTable('print_finishing_rates', {
  option_id: integer('option_id')
    .primaryKey()
    .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
  amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
  updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * شرائح الكمية — **على مجموع الصفحات المطبوعة** (الصفحات × النسخ)، وتخصم من
 * جزء الصفحات وحده. التجليد عملٌ لكل نسخة لا يرخص بالعدد.
 */
export const printQuantityTiersTable = pgTable('print_quantity_tiers', {
  id: serial('id').primaryKey(),
  min_pages: integer('min_pages').notNull().unique(),
  discount_percent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull(),
});

/** صفٌّ واحد (`id = 1`). */
export const printSettingsTable = pgTable('print_settings', {
  id: smallint('id').primaryKey(),
  /** كم يبتعد سعر الفرع عن المركزي صعوداً أو نزولاً. */
  branch_band_percent: numeric('branch_band_percent', { precision: 5, scale: 2 })
    .notNull()
    .default('20'),
  /** بعد الاستلام — قرار 2026-09-24. */
  file_retention_days: integer('file_retention_days').notNull().default(30),
  max_file_mb: integer('max_file_mb').notNull().default(50),
  max_pages: integer('max_pages').notNull().default(2000),
  /** الطلب المسعَّر غير المدفوع يسقط بعدها — قرار 2026-09-28. */
  unpaid_timeout_days: integer('unpaid_timeout_days').notNull().default(3),
  /** A copy on the ready shelf this old is marked — the season it was printed for is likely over (9-ح-3). */
  ready_stale_days: integer('ready_stale_days').notNull().default(30),
  updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * قدرة الفرع — **الغياب «مفعَّل»**، والصفّ يوجد ليقول «لا» (فرعٌ بلا تجليد
 * حلزوني). الافتراض المعاكس كان سيجعل كل فرعٍ جديد لا يطبع شيئاً حتى يمرّ
 * أحدٌ على عشرين خياراً.
 */
export const printBranchOptionsTable = pgTable(
  'print_branch_options',
  {
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
    option_id: integer('option_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
    is_enabled: boolean('is_enabled').notNull(),
    updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branch_id, table.option_id] }),
  }),
);

/** استثناء سعر الصفحة لفرع — **ضمن النطاق** (`print_settings.branch_band_percent`). */
export const printBranchPageRatesTable = pgTable(
  'print_branch_page_rates',
  {
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
    paper_size_id: integer('paper_size_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
    color_mode_id: integer('color_mode_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
    sides_id: integer('sides_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.branch_id, table.paper_size_id, table.color_mode_id, table.sides_id],
    }),
    branchIdx: index('print_branch_page_rates_branch_idx').on(table.branch_id),
  }),
);

/** استثناء سعر التشطيب لفرع — ضمن النطاق نفسه. */
export const printBranchFinishingRatesTable = pgTable(
  'print_branch_finishing_rates',
  {
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
    option_id: integer('option_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branch_id, table.option_id] }),
  }),
);

export type PrintOptionRow = typeof printOptionsTable.$inferSelect;
export type NewPrintOptionRow = typeof printOptionsTable.$inferInsert;
export type PrintPageRateRow = typeof printPageRatesTable.$inferSelect;
export type PrintFinishingRateRow = typeof printFinishingRatesTable.$inferSelect;
export type PrintQuantityTierRow = typeof printQuantityTiersTable.$inferSelect;
export type PrintSettingsRow = typeof printSettingsTable.$inferSelect;
