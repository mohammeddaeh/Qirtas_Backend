import { sql } from 'drizzle-orm';
import {
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
import { mediaAssetsTable } from '../../../core/media/schemas/media-assets.schema.js';
import { salesTable } from '../../sales/schemas/sales.schema.js';
import { printOptionsTable } from './printing.schema.js';

/**
 * طلب الطباعة — الشريحة 9-ج-2 (`docs/reference/printing_system.md`
 * §قرارات مراجعة المرفقات).
 *
 * - `draft` — الزبون يبني الطلب: المواصفة والملفات والروابط. لا رقم بعد.
 * - `awaiting_quote` — أُرسل. **الموظف يفتح الملفات ويُدخل عدد الصفحات** (قرار
 *   2026-09-28: لا عدّ آلي ولا LibreOffice)، والخادم يسعّر.
 * - `awaiting_payment` — مسعَّر. الزبون يرى السعر **قبل** أي ورق، ومهلته
 *   `unpaid_timeout_days` (٣ أيام) ثم `expired`.
 * - `queued` — **الدفع مثبَّت** (مدفوع بفاتورة الصندوق أو مؤجَّل بموافقة —
 *   9-ج-3). هذه **بوابة الإنتاج**: لا ورق ولا حبر قبلها.
 * - `in_production` → `ready` → `picked_up`.
 * - `cancelled` (قرارُ أحد) · `expired` (لم يدفع أحد) — **حالتان لا واحدة**:
 *   جمعهما يُخفي عن الفرع كم طلباً يضيع بلا أن يلغيه أحد (درس الطلبات نفسه).
 */
export const PRINT_JOB_STATUSES = [
  'draft',
  'awaiting_quote',
  'awaiting_payment',
  'queued',
  'in_production',
  'ready',
  'picked_up',
  'cancelled',
  'expired',
] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];
export const printJobStatusEnum = pgEnum('print_job_status', PRINT_JOB_STATUSES);

/**
 * Where an order came from (9-ح-1) — one table for every print, so one record,
 * one search and one report: `app` (sent from the customer app) · `counter`
 * (the customer standing at the till) · `reprint` («print it again»).
 */
export const PRINT_JOB_SOURCES = ['app', 'counter'] as const;
export type PrintJobSource = (typeof PRINT_JOB_SOURCES)[number];
export const printJobSourceEnum = pgEnum('print_job_source', PRINT_JOB_SOURCES);

/**
 * **الدفع عمودٌ مستقل عن المرحلة**: مؤجَّلٌ بموافقة يدخل الإنتاج وهو غير
 * مدفوع، ومدفوعٌ قد ينتظر الطابعة. حالةٌ واحدة تجمعهما تحتاج ضرب الحالات.
 */
export const PRINT_PAYMENT_STATUSES = ['unpaid', 'paid', 'deferred'] as const;
export type PrintPaymentStatus = (typeof PRINT_PAYMENT_STATUSES)[number];
export const printPaymentStatusEnum = pgEnum('print_payment_status', PRINT_PAYMENT_STATUSES);

export const printJobsTable = pgTable(
  'print_jobs',
  {
    id: serial('id').primaryKey(),
    /** `MZ-P-2026-000001` — يُصرف عند الإرسال: المسودة المتروكة لا تثقب التسلسل. */
    number: varchar('number', { length: 40 }),
    sequence: integer('sequence'),

    /** الفرع المنفِّذ: طابوره وورقه وحبره — الإنتاج مستقل لكل فرع. */
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    /**
     * The registered customer — `null` for a regular known only by name, or a
     * walk-in (9-ح-1). Then [contact_name]/[contact_phone] say who it was.
     */
    customer_id: integer('customer_id').references(() => customersTable.id, { onDelete: 'restrict' }),
    source: printJobSourceEnum('source').notNull().default('app'),
    /** A name typed at the counter (a regular without an account); `null` for a walk-in. */
    contact_name: varchar('contact_name', { length: 120 }),
    contact_phone: varchar('contact_phone', { length: 32 }),

    status: printJobStatusEnum('status').notNull().default('draft'),
    payment_status: printPaymentStatusEnum('payment_status').notNull().default('unpaid'),

    // الأبعاد الخمسة إلزامية — «بلا تجليد» خيارٌ يُختار (`printing.schema.ts`).
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
    copies: integer('copies').notNull().default(1),
    /** ما يقوله الزبون للموظف: «الصفحات ١–٢٠ فقط»، «الغلاف أزرق». */
    note: text('note'),

    /** صفحات النسخة الواحدة — **يكتبها الموظف** بعد فتح الملفات. `null` حتى يُسعَّر. */
    total_pages: integer('total_pages'),
    /**
     * تفصيل السعر **مجمَّداً** لحظة التسعير (شكل `/printing/quote` نفسه): سعرٌ
     * يتغيّر بالجدول بعد أن رآه الزبون وعدٌ مكسور، والتفصيل ما يُقرأ عند الخلاف.
     */
    quote: jsonb('quote'),
    quoted_total_syp: numeric('quoted_total_syp', { precision: 14, scale: 2 }),
    quoted_by: integer('quoted_by').references(() => usersTable.id, { onDelete: 'set null' }),
    quoted_at: timestamp('quoted_at', { withTimezone: true }),
    /** متى يسقط الطلب المسعَّر غير المدفوع. `null` خارج `awaiting_payment`. */
    payment_due_at: timestamp('payment_due_at', { withTimezone: true }),

    /**
     * فاتورة الصندوق التي تحمل الطلب سطراً (قرار 2026-09-28). ما دامت غير
     * مدفوعة فالطلب «عند الصندوق»: مهلته موقوفة، ولا يُعاد تسعيره ولا يُلغى —
     * الكاشير يقبض رقماً رآه الزبون. وبعد الدفع تبقى الجسر إلى الفاتورة.
     */
    sale_id: integer('sale_id').references(() => salesTable.id, { onDelete: 'set null' }),
    paid_at: timestamp('paid_at', { withTimezone: true }),
    /** الطباعة قبل الدفع — **باسم من قرّر ولماذا** (`printing.payment.defer`). */
    deferred_by: integer('deferred_by').references(() => usersTable.id, { onDelete: 'set null' }),
    deferred_at: timestamp('deferred_at', { withTimezone: true }),
    deferred_reason: text('deferred_reason'),

    /**
     * تكلفة المواد المستهلكة **لحظة بدء الطباعة** (9-هـ) — `null` قبلها. ربح
     * الطلب = `quoted_total_syp − materials_cost_syp`، مجمَّداً لا يُعاد حسابه
     * بمتوسطٍ تغيّر بعدها.
     */
    materials_cost_syp: numeric('materials_cost_syp', { precision: 14, scale: 2 }),
    /**
     * Fulfilled from the ready shelf instead of printed (`finance_ledger.md` §٤):
     * the copy it took. `materials_cost_syp` then holds the copies' value.
     */
    fulfilled_from_ready_id: integer('fulfilled_from_ready_id'),
    /**
     * Copies handed over from the ready shelf (9-ز-5). Equal to `copies` when
     * the shelf covered the order; fewer when it did not — the rest is printed,
     * and only the rest consumes paper. 0 when nothing came off the shelf.
     */
    from_ready_copies: integer('from_ready_copies').notNull().default(0),
    /** The shelf copies' value — added to the printed rest's materials at start. */
    ready_value_syp: numeric('ready_value_syp', { precision: 14, scale: 2 }),
    /** «كتب الصف الرابع» — يكتبه الموظف عند التسعير، وبه يُطابَق رفّ الجاهز (م-٢). */
    label: varchar('label', { length: 120 }),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),

    cancel_reason: text('cancel_reason'),
    cancelled_by: integer('cancelled_by').references(() => usersTable.id, { onDelete: 'set null' }),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    submitted_at: timestamp('submitted_at', { withTimezone: true }),
    production_started_at: timestamp('production_started_at', { withTimezone: true }),
    ready_at: timestamp('ready_at', { withTimezone: true }),
    /**
     * Pickup code (9-ز-2) — issued the moment the copies are ready, written or
     * stuck on them, read back at the till. Central numbering (type `pickup`).
     */
    pickup_code: varchar('pickup_code', { length: 24 }),
    picked_up_at: timestamp('picked_up_at', { withTimezone: true }),
    closed_at: timestamp('closed_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    numberOnce: uniqueIndex('print_jobs_number_once')
      .on(table.branch_id, table.number)
      .where(sql`${table.number} IS NOT NULL`),
    queueIdx: index('print_jobs_queue_idx').on(table.branch_id, table.status, table.submitted_at),
    contactIdx: index('print_jobs_contact_idx').on(table.contact_phone),
    pickupIdx: index('print_jobs_pickup_idx').on(table.branch_id, table.pickup_code),
    customerIdx: index('print_jobs_customer_idx').on(table.customer_id, table.created_at),
    /** الكنس الكسول يقرأ بالحالة والمهلة معاً. */
    dueIdx: index('print_jobs_due_idx').on(table.status, table.payment_due_at),
  }),
);

/**
 * ملفات الطلب — **الملف نفسه بـ`media_assets`** (`core/media/`، عامٌ لكل
 * الموديولات)، وهذا الجدول يقول لمن هو وبأي ترتيب. صلاحية قراءة الملف هي
 * صلاحية قراءة طلبه.
 */
export const printJobFilesTable = pgTable(
  'print_job_files',
  {
    id: serial('id').primaryKey(),
    job_id: integer('job_id')
      .notNull()
      .references(() => printJobsTable.id, { onDelete: 'cascade' }),
    media_asset_id: integer('media_asset_id')
      .notNull()
      .references(() => mediaAssetsTable.id, { onDelete: 'restrict' }),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** ملفٌ لطلبٍ واحد: مشاركته بين طلبين تجعل حذف أحدهما يمسح ملف الآخر. */
    assetOnce: uniqueIndex('print_job_files_asset_once').on(table.media_asset_id),
    jobIdx: index('print_job_files_job_idx').on(table.job_id),
  }),
);

/**
 * روابط يطلب الزبون طباعتها — **تُحفظ نصاً والخادم لا يجلبها أبداً** (لا سطح
 * SSRF). `https` وحدها، والموظف يفتحها ويعدّ صفحاتها.
 */
export const printJobLinksTable = pgTable(
  'print_job_links',
  {
    id: serial('id').primaryKey(),
    job_id: integer('job_id')
      .notNull()
      .references(() => printJobsTable.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    note: varchar('note', { length: 200 }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdx: index('print_job_links_job_idx').on(table.job_id),
  }),
);

/** تسلسل طلبات الطباعة لكل (فرع × سنة) — مستقلٌّ عن الفواتير والطلبات. */
export const printJobSequencesTable = pgTable(
  'print_job_sequences',
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

export type PrintJobRow = typeof printJobsTable.$inferSelect;
export type NewPrintJobRow = typeof printJobsTable.$inferInsert;
export type PrintJobFileRow = typeof printJobFilesTable.$inferSelect;
export type PrintJobLinkRow = typeof printJobLinksTable.$inferSelect;
