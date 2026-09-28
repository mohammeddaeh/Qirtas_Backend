import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { printOptionsTable } from './printing.schema.js';
import { printJobsTable } from './print-jobs.schema.js';

/**
 * وصفة الاستهلاك — الشريحة 9-هـ (`printing_system.md` §خطة 9-هـ).
 *
 * الطباعة **بيعٌ واحد يستهلك عدة أصناف** من مخزون الفرع. والوصفة تقول لكل خيار
 * مواصفة ما يستهلكه وعلى أي أساس، فيُخصم المخزون عند بدء الطباعة ويُعرف ربح
 * الطلب.
 *
 * - `per_sheet` — لكل ورقة (الوجهان صفحتان بالورقة): ورق A4.
 * - `per_printed_page` — لكل صفحة مطبوعة (الصفحات × النسخ): الحبر.
 * - `per_copy` — لكل نسخة: سلك التجليد، الغلاف.
 * - `per_job` — مرة للطلب: ظرفٌ أو ملصق.
 */
export const CONSUMPTION_BASES = ['per_sheet', 'per_printed_page', 'per_copy', 'per_job'] as const;
export type ConsumptionBasis = (typeof CONSUMPTION_BASES)[number];
export const consumptionBasisEnum = pgEnum('print_consumption_basis', CONSUMPTION_BASES);

/**
 * قاعدة واحدة: خيارٌ × مادة. **الكمية أو المردود، لا الاثنان**:
 *
 * - `qty` — كم وحدة أساس من المادة لكل وحدة أساس (ورقة A4 × ١ لكل ورقة).
 * - `yield_pages` — للحبر: «العلبة تكفي N صفحة»، فكل صفحة تستهلك ١/N علبة.
 *   ويُصحَّح بالواقع عند تركيب علبة جديدة (`print_consumable_meters`).
 *
 * **مركزية لكل الفروع** (المادة واحدة)، والخصم من مخزون الفرع المنفِّذ.
 */
export const printConsumptionRulesTable = pgTable(
  'print_consumption_rules',
  {
    id: serial('id').primaryKey(),
    option_id: integer('option_id')
      .notNull()
      .references(() => printOptionsTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    basis: consumptionBasisEnum('basis').notNull(),
    qty: numeric('qty', { precision: 14, scale: 6 }),
    yield_pages: integer('yield_pages'),
    updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    once: uniqueIndex('print_consumption_rules_once').on(table.option_id, table.variant_id),
    qtyOrYield: check(
      'print_consumption_rules_qty_or_yield',
      sql`(${table.qty} IS NOT NULL AND ${table.qty} > 0 AND ${table.yield_pages} IS NULL) OR (${table.qty} IS NULL AND ${table.yield_pages} IS NOT NULL AND ${table.yield_pages} > 0)`,
    ),
  }),
);

/**
 * عدّاد كل مادة بكل فرع — **بدقة أعلى من المخزون**.
 *
 * المخزون بثلاث خانات عشرية؛ وحبر صفحةٍ واحدة (١/٢٠٠٠ علبة) يضيع بالتقريب.
 * فالكسور تتجمّع هنا (`pending`) ويُرحَّل للمخزون ما بلغ ٠٫٠٠١ فما فوق، والباقي
 * ينتظر الطلب التالي — **لا كسرٌ يضيع**.
 *
 * و«منذ آخر تركيب» (`since_install`، `pages_since_install`) للمواد بالمردود:
 * حين يضغط الموظف «ركّبت علبة جديدة» يُقارَن المقدَّر بالواقع (علبة كاملة)
 * ويُرحَّل الفرق تسويةً.
 */
export const printConsumableMetersTable = pgTable(
  'print_consumable_meters',
  {
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'cascade' }),
    /** مستهلَكٌ لم يُرحَّل للمخزون بعد (أقل من ٠٫٠٠١). */
    pending: numeric('pending', { precision: 18, scale: 9 }).notNull().default('0'),
    /** المقدَّر استهلاكه منذ آخر تركيب — مرحَّلاً ومعلَّقاً معاً. */
    since_install: numeric('since_install', { precision: 18, scale: 9 }).notNull().default('0'),
    pages_since_install: integer('pages_since_install').notNull().default(0),
    /** `null` = لم يُسجَّل تركيبٌ بعد: أول «علبة جديدة» خطُّ بداية لا تسوية. */
    installed_at: timestamp('installed_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branch_id, table.variant_id] }),
  }),
);

/**
 * ما استهلكه طلبٌ بعينه **بتكلفته لحظة الخصم** — ربح الطلب يُقرأ منه بعد
 * شهور بلا إعادة حساب متوسطٍ تغيّر.
 */
export const printJobConsumptionTable = pgTable(
  'print_job_consumption',
  {
    job_id: integer('job_id')
      .notNull()
      .references(() => printJobsTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    /** الكمية الدقيقة (لا المرحَّلة المقرَّبة) — التكلفة الحقيقية للطلب. */
    qty: numeric('qty', { precision: 18, scale: 9 }).notNull(),
    unit_cost_syp: numeric('unit_cost_syp', { precision: 14, scale: 2 }).notNull(),
    cost_syp: numeric('cost_syp', { precision: 14, scale: 2 }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.job_id, table.variant_id] }),
  }),
);

/**
 * سجلّ «ركّبت علبة جديدة» — ما قُدِّر وما كان فعلاً والفرق المرحَّل، والمردود
 * الذي تقترحه الأرقام. به يُراجَع تقديرٌ بعيد عن الواقع قبل أن يكذب ربح كل طلب.
 */
export const printConsumableReconciliationsTable = pgTable('print_consumable_reconciliations', {
  id: serial('id').primaryKey(),
  branch_id: integer('branch_id')
    .notNull()
    .references(() => branchesTable.id, { onDelete: 'cascade' }),
  variant_id: integer('variant_id')
    .notNull()
    .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
  /** `true` = أول تركيبٍ يُسجَّل — خطُّ بداية بلا تسوية. */
  baseline: boolean('baseline').notNull().default(false),
  estimated: numeric('estimated', { precision: 18, scale: 9 }).notNull(),
  actual: numeric('actual', { precision: 14, scale: 3 }).notNull(),
  /** ما رُحِّل للمخزون: موجب = استُهلك أكثر من المقدَّر، سالب = أقل (أُعيد). */
  correction: numeric('correction', { precision: 14, scale: 3 }).notNull(),
  pages: integer('pages').notNull(),
  suggested_yield_pages: integer('suggested_yield_pages'),
  created_by: integer('created_by').references(() => usersTable.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PrintConsumptionRuleRow = typeof printConsumptionRulesTable.$inferSelect;
export type PrintConsumableMeterRow = typeof printConsumableMetersTable.$inferSelect;
