import {
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
import { usersTable } from '../../identity/schemas/users.schema.js';
import { customersTable } from '../../customers/schemas/customers.schema.js';
import { catalogVariantsTable, catalogProductsTable } from '../../catalog/schemas/products.schema.js';
import { salesTable } from './sales.schema.js';

/**
 * السلّة والطلب الإلكتروني — `orders_delivery.md` و`inventory_suppliers.md` §٦.
 *
 * **السلّة لا تحجز شيئاً** (§٦): سلاتٌ متروكة تجمّد المخزون، فيقرأ الكاشير رفّاً
 * ممتلئاً ولا يستطيع بيع شيء منه. **والتأكيد يحجز** بمعاملة ذرّية مع فحص
 * المتاح — وهو ما يسدّ سباق آخر قطعة.
 */

/**
 * - `pending_pickup` — مؤكَّد ومحجوز، ينتظر أن يأتي صاحبه.
 * - `picked_up` — سُلِّم وسُدِّد بالصندوق؛ الحجز تحوّل إلى بيع.
 * - `cancelled` — ألغاه الزبون أو الفرع، والحجز حُرِّر.
 * - `expired` — انتهت مهلته فحُرِّر حجزه تلقائياً.
 *
 * **و`expired` ليست `cancelled`**: الأولى تقول إن الزبون لم يأتِ، والثانية إن
 * أحداً قرّر — وجمعُهما يُخفي عن الفرع كم طلباً يضيع بلا أن يلغيه أحد.
 */
export const orderStatusEnum = pgEnum('order_status', [
  'pending_pickup',
  'picked_up',
  'cancelled',
  'expired',
]);

/**
 * سلّة الزبون **بالخادم** (قرار 2026-09-24): يجدها على هاتفه وحاسوبه.
 *
 * **وواحدة لكل (زبون × فرع)**: الفرع يُنفّذ السطر (`orders_delivery.md`)،
 * وسلّةٌ واحدة عابرة للفروع كانت ستعرض أسعار فرعٍ وبضاعة آخر بالشاشة نفسها.
 */
export const cartsTable = pgTable(
  'carts',
  {
    id: serial('id').primaryKey(),
    customer_id: integer('customer_id')
      .notNull()
      .references(() => customersTable.id, { onDelete: 'cascade' }),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    once: uniqueIndex('carts_customer_branch_once').on(table.customer_id, table.branch_id),
  }),
);

export const cartLinesTable = pgTable(
  'cart_lines',
  {
    id: serial('id').primaryKey(),
    cart_id: integer('cart_id')
      .notNull()
      .references(() => cartsTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'cascade' }),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * صنفٌ واحد لكل سلّة: إضافته مرتين **ترفع الكمية**. سطران بخمسة يفوّتان
     * شريحة العشرة، ويقرأ الزبون صنفه مرتين بالمراجعة.
     */
    once: uniqueIndex('cart_lines_once').on(table.cart_id, table.variant_id),
  }),
);

export const ordersTable = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),

    /** `MZ-O-2026-000001` — تسلسلٌ مستقل عن الفواتير والمرتجعات. */
    number: varchar('number', { length: 40 }).notNull(),
    sequence: integer('sequence').notNull(),

    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    customer_id: integer('customer_id')
      .notNull()
      .references(() => customersTable.id, { onDelete: 'restrict' }),

    status: orderStatusEnum('status').notNull().default('pending_pickup'),

    /**
     * المجاميع **مجمَّدة لحظة التأكيد** — لا تُعاد قراءتها من الكتالوج: عرضٌ
     * ينتهي بين التأكيد والاستلام كان سيغيّر ما وعدت به الشاشة.
     *
     * **وهي تقديرية حتى السداد**: الفاتورة تُصدَر بالصندوق عند الاستلام، وهي
     * الحَكَم. وذكرُ ذلك بالواجهة يمنع خلافاً على ليرات.
     */
    subtotal_syp: numeric('subtotal_syp', { precision: 14, scale: 2 }).notNull().default('0'),
    discount_syp: numeric('discount_syp', { precision: 14, scale: 2 }).notNull().default('0'),
    tax_syp: numeric('tax_syp', { precision: 14, scale: 2 }).notNull().default('0'),
    total_syp: numeric('total_syp', { precision: 14, scale: 2 }).notNull().default('0'),

    /** متى يسقط الحجز إن لم يأتِ أحد. `null` = بلا مهلة (السياسة صفر). */
    reserved_until: timestamp('reserved_until', { withTimezone: true }),

    /** الفاتورة التي صدرت عند الاستلام — الجسر بين الطلب والبيع. */
    sale_id: integer('sale_id').references(() => salesTable.id, { onDelete: 'set null' }),

    note: text('note'),
    cancel_reason: text('cancel_reason'),
    cancelled_by: integer('cancelled_by').references(() => usersTable.id, { onDelete: 'set null' }),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    picked_up_at: timestamp('picked_up_at', { withTimezone: true }),
    closed_at: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    numberOnce: uniqueIndex('orders_number_once').on(table.branch_id, table.number),
    branchIdx: index('orders_branch_idx').on(table.branch_id, table.status, table.created_at),
    customerIdx: index('orders_customer_idx').on(table.customer_id, table.created_at),
    /** كنسُ المنتهية يقرأ بالحالة والمهلة معاً. */
    expiryIdx: index('orders_expiry_idx').on(table.status, table.reserved_until),
  }),
);

export const orderLinesTable = pgTable(
  'order_lines',
  {
    id: serial('id').primaryKey(),
    order_id: integer('order_id')
      .notNull()
      .references(() => ordersTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    product_id: integer('product_id')
      .notNull()
      .references(() => catalogProductsTable.id, { onDelete: 'restrict' }),

    /** منسوخان كسطر البيع: الطلب يُقرأ بعد شهور بلا كتالوج. */
    name_ar: text('name_ar').notNull(),
    sku: varchar('sku', { length: 40 }).notNull(),

    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    unit_price_syp: numeric('unit_price_syp', { precision: 14, scale: 2 }).notNull(),
    promotion_discount_syp: numeric('promotion_discount_syp', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    promotion_names: text('promotion_names'),
    tax_percent: numeric('tax_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    line_total_syp: numeric('line_total_syp', { precision: 14, scale: 2 }).notNull().default('0'),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orderIdx: index('order_lines_order_idx').on(table.order_id),
  }),
);

/** تسلسل الطلبات لكل (فرع × سنة) — مستقلٌّ عن البيع والمرتجع. */
export const orderSequencesTable = pgTable(
  'order_sequences',
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

export type OrderRow = typeof ordersTable.$inferSelect;
export type OrderLineRow = typeof orderLinesTable.$inferSelect;
export type CartRow = typeof cartsTable.$inferSelect;
export type CartLineRow = typeof cartLinesTable.$inferSelect;
