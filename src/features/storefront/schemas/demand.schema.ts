import { index, integer, pgEnum, pgTable, serial, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { customersTable } from '../../customers/schemas/customers.schema.js';

/**
 * «أعلمني عند التوفّر» و«اطلب توفيره بفرعي» — store_system.md §٨.
 *
 * **الطلب يصير إشارة.** الزبون يقول إنه يريد شيئاً ليس على الرف، والنقص يتحوّل
 * من حالةٍ تُعرض إلى معلومةٍ يتصرّف بها مدير الفرع: «١٢ زبوناً طلبوا X بفرع
 * المزة». بلا هذا الجدول تبقى «نفد حالياً» نهايةَ الحديث — يغادر الزبون ولا
 * يعرف أحد أنه جاء.
 *
 * **ولا ينشئ نقلاً تلقائياً** (قرار 2026-09-23): أمر نقل لكل طلب زبون يُغرق
 * الفروع بأوامر صغيرة، والقرار يبقى بيد المدير الذي يرى العدد والعمر معاً.
 */

/**
 * ما الذي طلبه الزبون بالضبط — والفرق بينهما قرار المدير لا صياغة:
 * - `notify` — «نفد بكل مكان»: لا بضاعة تُنقل، والجواب شراءٌ من المورد.
 * - `request_here` — «موجود بفرع آخر»: الجواب نقلٌ من فرع فائض.
 */
export const demandKindEnum = pgEnum('storefront_demand_kind', ['notify', 'request_here']);

export const storefrontDemandTable = pgTable(
  'storefront_demand',
  {
    id: serial('id').primaryKey(),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'cascade' }),
    /** الفرع الذي يتسوّق منه — الطلب عن **مكان**، لا عن المتجر كله. */
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
    /** للمسجَّل وحده (قرار 2026-09-23): الإشعار يصل بقناة الحساب القائمة. */
    customer_id: integer('customer_id')
      .notNull()
      .references(() => customersTable.id, { onDelete: 'cascade' }),
    kind: demandKindEnum('kind').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * متى أُعلم الزبون بتوفّره. `null` = ما زال ينتظر — وهو ما يُعدّ بالإشارة:
     * طلبٌ أُجيب عنه لم يعد نقصاً.
     */
    notified_at: timestamp('notified_at', { withTimezone: true }),
  },
  (table) => ({
    /**
     * طلبٌ واحد لكل (زبون × صنف × فرع × نوع). الضغط مرتين لا يضاعف العدد —
     * وإلا صار «١٢ زبوناً» رقماً يصنعه زبون واحد بأصابعه، والمدير ينقل بضاعة
     * لطلبٍ لا وجود له.
     */
    once: uniqueIndex('storefront_demand_once').on(
      table.customer_id,
      table.variant_id,
      table.branch_id,
      table.kind,
    ),
    /** تجميع اللوحة يقرأ بالفرع أولاً. */
    branchIdx: index('storefront_demand_branch_idx').on(table.branch_id, table.variant_id),
  }),
);

export type StorefrontDemandRow = typeof storefrontDemandTable.$inferSelect;
export type NewStorefrontDemandRow = typeof storefrontDemandTable.$inferInsert;
