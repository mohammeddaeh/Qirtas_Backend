import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { catalogBrandsTable } from '../../catalog/schemas/brands.schema.js';
import { catalogCategoriesTable } from '../../catalog/schemas/categories.schema.js';
import {
  catalogProductsTable,
  catalogVariantsTable,
} from '../../catalog/schemas/products.schema.js';

/**
 * العروض والتخفيضات — `store_system.md` §٥.
 *
 * **العرض قاعدة مؤقتة تعلو السعر، لا سعرٌ ثانٍ.** كتابته كسعر (صفّ بجدول
 * الأسعار ينتهي بتاريخ) كانت ستجعل انتهاءه يحتاج من يمسحه، والعرض المنسيّ
 * يبقى يبيع بخسارة إلى الأبد. وهنا الانتهاء **غياب**: نافذة مغلقة ⇒ لا ينطبق،
 * والسعر الأصلي يعود بلا أي كتابة.
 *
 * **والسعر النهائي يُحسب بالخادم وحده** (§١١): العميل يعرض الرقمين — قبل وبعد
 * — ولا يضرب نسبةً بشيء. نسختان من «أي عرض يسود» تختلفان أول تعديل،
 * والاختلاف يظهر رقماً معقولاً على الرفّ بلا أي فشل.
 */

/**
 * أين ينطبق. `branches` تشمل «فرعٌ واحد» (صفّ واحد بجدول الفروع) — قيمةٌ ثالثة
 * لحالةٍ هي حالة خاصة من ثانية تضيف فرعاً بآلة الحالات ولا تضيف معنى.
 */
export const promotionScopeEnum = pgEnum('promotion_scope', ['all_branches', 'branches']);

/**
 * ما الذي يُخصم منه. الأربعة **حصريّة** (قيد `promotion_one_target`): هدفان
 * على صفٍّ واحد يجعلان «هل ينطبق؟» سؤالاً بجوابين.
 */
export const promotionTargetEnum = pgEnum('promotion_target', [
  'variant',
  'product',
  'category',
  'brand',
]);

/**
 * - `percent` / `amount` — قرارٌ على **البند**: يُحلّ مع السعر ويظهر بصفحة المنتج.
 * - `qty_tiers` — قرارٌ على البند أيضاً لكنه **دالّة بالكمية**، فسعر العرض
 *   الواحد يُحسب بكمية ١ ويُعرض معه جدول الشرائح.
 * - `buy_x_get_y` — قرارٌ على **السلّة** لا على سعر بند: الهدية وحدةٌ تُضاف.
 *   يُحفظ ويُعرض ويُحسب بـ`POST /promotions/preview`، ويدخل البيع يوم تُبنى
 *   السلّة (المرحلة ٧) بلا تعديل هنا.
 */
export const promotionKindEnum = pgEnum('promotion_kind', [
  'percent',
  'amount',
  'buy_x_get_y',
  'qty_tiers',
]);

/** أونلاين · نقطة بيع · الاثنان. عرضُ الإنترنت الذي يُطبَّق بالكاشير يُخسِّر مرتين. */
export const promotionChannelEnum = pgEnum('promotion_channel', ['online', 'pos', 'both']);

/** تجزئة · جملة · الكل. سعر الجملة خصمٌ متفاوَض عليه، وعرضُ تجزئةٍ فوقه قرارٌ يُعلَن لا يُفترض. */
export const promotionSegmentEnum = pgEnum('promotion_segment', ['retail', 'wholesale', 'all']);

export const promotionsTable = pgTable(
  'promotions',
  {
    id: serial('id').primaryKey(),
    name_ar: text('name_ar').notNull(),
    name_en: text('name_en'),

    scope: promotionScopeEnum('scope').notNull().default('all_branches'),
    target_kind: promotionTargetEnum('target_kind').notNull(),

    /**
     * الهدف بمفتاح أجنبي حقيقي لا برقمٍ حرّ: تصنيفٌ يُحذف يأخذ عرضه معه.
     * برقمٍ حرّ كان العرض يبقى يشير إلى لا شيء — لا ينطبق على أحد ولا يُحذف،
     * ويُقرأ بالقائمة عرضاً فعّالاً.
     */
    variant_id: integer('variant_id').references(() => catalogVariantsTable.id, {
      onDelete: 'cascade',
    }),
    product_id: integer('product_id').references(() => catalogProductsTable.id, {
      onDelete: 'cascade',
    }),
    category_id: integer('category_id').references(() => catalogCategoriesTable.id, {
      onDelete: 'cascade',
    }),
    brand_id: integer('brand_id').references(() => catalogBrandsTable.id, { onDelete: 'cascade' }),

    kind: promotionKindEnum('kind').notNull(),
    /** `percent` — نسبة على سعر الوحدة. */
    percent_value: numeric('percent_value', { precision: 5, scale: 2 }),
    /** `amount` — مبلغ يُحسم من **سعر الوحدة**، مسقوفاً بالسعر نفسه (لا سعر سالب). */
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }),
    /** `buy_x_get_y` — المجموعة = `buy_qty + get_qty`، و`get_percent` ١٠٠ تعني مجاناً. */
    buy_qty: integer('buy_qty'),
    get_qty: integer('get_qty'),
    get_percent: numeric('get_percent', { precision: 5, scale: 2 }),

    /**
     * النافذة. `starts_at` غائبة = من الآن، و`ends_at` غائبة = بلا نهاية —
     * **وهي الحالة التي تستحق تحذيراً بالواجهة** لا منعاً: عرضٌ دائم قرارٌ
     * مشروع، ونسيانه هو الخطر.
     *
     * و`ends_at` **لحظةُ التوقّف** لا آخر لحظة سريان: «حتى ٣٠ أيلول» تُخزَّن
     * منتصف ليل ١ تشرين، وإلا سقط اليوم الأخير بصمت (نفس قاعدة `Collection`).
     */
    starts_at: timestamp('starts_at', { withTimezone: true }),
    ends_at: timestamp('ends_at', { withTimezone: true }),

    channel: promotionChannelEnum('channel').notNull().default('both'),
    segment: promotionSegmentEnum('segment').notNull().default('all'),

    /**
     * افتراضياً `false` (§٥): انطباق عرضين ⇒ **الأفضل للزبون**، لا مجموعهما.
     * التراكم يُعلَن صراحةً لأن عرضين بنسبة ٥٠٪ يجعلان الصنف مجاناً، وذلك
     * يحدث بلا أن يقصده أحد.
     */
    is_stackable: boolean('is_stackable').notNull().default(false),
    is_active: boolean('is_active').notNull().default(true),

    /**
     * العرض المنتهي يبقى: الفواتير القديمة تشير إليه، و«لماذا بِعنا بهذا
     * السعر؟» جوابه صفٌّ هنا. الأرشفة تُخفيه من القوائم ولا تمحو الجواب.
     */
    archived_at: timestamp('archived_at', { withTimezone: true }),

    created_by: integer('created_by').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** هدفٌ واحد بالضبط — لا صفر ولا اثنان. */
    oneTarget: check(
      'promotion_one_target',
      sql`(CASE WHEN ${table.variant_id} IS NULL THEN 0 ELSE 1 END
         + CASE WHEN ${table.product_id} IS NULL THEN 0 ELSE 1 END
         + CASE WHEN ${table.category_id} IS NULL THEN 0 ELSE 1 END
         + CASE WHEN ${table.brand_id} IS NULL THEN 0 ELSE 1 END) = 1`,
    ),
    /** النافذة المقلوبة عرضٌ لا يعمل أبداً ويُقرأ بالقائمة عاملاً. */
    window: check(
      'promotion_window_ordered',
      sql`${table.starts_at} IS NULL OR ${table.ends_at} IS NULL OR ${table.ends_at} > ${table.starts_at}`,
    ),
    /** حلّ السعر يقرأ الفعّال غير المؤرشف وحده، ويصفّيه بالهدف. */
    liveIdx: index('promotions_live_idx').on(table.is_active, table.archived_at, table.kind),
    targetIdx: index('promotions_target_idx').on(
      table.variant_id,
      table.product_id,
      table.category_id,
      table.brand_id,
    ),
  }),
);

/** فروع العرض حين `scope = 'branches'`. فارغةٌ مع هذا النطاق = عرضٌ لا فرع له، وتُرفض بالخدمة. */
export const promotionBranchesTable = pgTable(
  'promotion_branches',
  {
    id: serial('id').primaryKey(),
    promotion_id: integer('promotion_id')
      .notNull()
      .references(() => promotionsTable.id, { onDelete: 'cascade' }),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    once: uniqueIndex('promotion_branches_once').on(table.promotion_id, table.branch_id),
  }),
);

/**
 * شرائح الكمية: «١٠ فأكثر بخصم ١٥٪». تُقرأ **الأعلى انطباقاً** (أكبر `min_qty`
 * لا تتجاوز الكمية) — لا مجموع الشرائح، وإلا حصلت الكمية ٢٠ على خصم الشريحتين.
 */
export const promotionTiersTable = pgTable(
  'promotion_tiers',
  {
    id: serial('id').primaryKey(),
    promotion_id: integer('promotion_id')
      .notNull()
      .references(() => promotionsTable.id, { onDelete: 'cascade' }),
    min_qty: integer('min_qty').notNull(),
    percent_value: numeric('percent_value', { precision: 5, scale: 2 }),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }),
  },
  (table) => ({
    once: uniqueIndex('promotion_tiers_once').on(table.promotion_id, table.min_qty),
  }),
);

/**
 * سقف الخصم الذي يملكه الفرع (قرار 2026-09-23: **نسبة واحدة لكل فرع**).
 *
 * سقفٌ لكل (فرع × تصنيف) كان أدقّ وجدولاً ثانياً بوراثةٍ عبر الشجرة وشاشةً
 * لإدارته؛ ونسبةٌ واحدة تُجيب «كم أستطيع؟» بجملة واحدة يقرأها مدير الفرع.
 *
 * **ولا يقيّد العرض المركزي**: الإدارة التي تحدّد السقف لا تُحَدّ به.
 * والفرع بلا صفّ هنا = بلا سقف خاص، فيسري الافتراضي (`DEFAULT_BRANCH_CAP`).
 */
export const promotionBranchCapsTable = pgTable('promotion_branch_caps', {
  branch_id: integer('branch_id')
    .primaryKey()
    .references(() => branchesTable.id, { onDelete: 'cascade' }),
  max_discount_percent: numeric('max_discount_percent', { precision: 5, scale: 2 }).notNull(),
  updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PromotionRow = typeof promotionsTable.$inferSelect;
export type NewPromotionRow = typeof promotionsTable.$inferInsert;
export type PromotionTierRow = typeof promotionTiersTable.$inferSelect;
export type PromotionBranchCapRow = typeof promotionBranchCapsTable.$inferSelect;
