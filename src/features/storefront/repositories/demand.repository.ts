import { and, asc, count, desc, eq, inArray, isNull, min, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { catalogProductsTable, catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { stockBalancesTable } from '../../inventory/schemas/stock.schema.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { customersTable } from '../../customers/schemas/customers.schema.js';
import {
  storefrontDemandTable,
  type NewStorefrontDemandRow,
  type StorefrontDemandRow,
} from '../schemas/demand.schema.js';

/** ما طلبه الزبائن وليس على الرف — store_system.md §٨. */

const d = storefrontDemandTable;

/**
 * يُسجَّل مرة واحدة لكل (زبون × صنف × فرع × نوع): الضغط مرتين لا يضاعف العدد،
 * ويُعيد الصف القائم كما هو — «سجّلنا طلبك» جوابٌ صحيح بالمرتين.
 */
export async function upsertDemand(row: NewStorefrontDemandRow): Promise<StorefrontDemandRow> {
  const [inserted] = await db
    .insert(d)
    .values(row)
    .onConflictDoUpdate({
      target: [d.customer_id, d.variant_id, d.branch_id, d.kind],
      // لمسة تُعيد فتح طلباً أُعلم صاحبه من قبل: من يسأل ثانيةً ما زال ينتظر.
      set: { notified_at: null },
    })
    .returning();
  return inserted!;
}

export async function deleteDemand(customerId: number, id: number): Promise<number> {
  const rows = await db
    .delete(d)
    .where(and(eq(d.id, id), eq(d.customer_id, customerId)))
    .returning({ id: d.id });
  return rows.length;
}

/** طلبات هذا الزبون بهذا الفرع — بها تعرف الشاشة أن الزرّ صار «أُلغِ الطلب». */
export function findMineAt(customerId: number, branchId: number): Promise<StorefrontDemandRow[]> {
  return db
    .select()
    .from(d)
    .where(and(eq(d.customer_id, customerId), eq(d.branch_id, branchId)))
    .orderBy(desc(d.created_at));
}

export function findMineFor(
  customerId: number,
  branchId: number,
  variantIds: number[],
): Promise<StorefrontDemandRow[]> {
  if (variantIds.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(d)
    .where(
      and(eq(d.customer_id, customerId), eq(d.branch_id, branchId), inArray(d.variant_id, variantIds)),
    );
}

/**
 * ما ينتظره الزبائن بفرع واحد، مجمَّعاً لكل صنف — وهذا هو شكل الإشارة: «١٢
 * زبوناً طلبوا X»، لا اثنا عشر صفاً يقرؤها المدير واحداً واحداً.
 *
 * والمُعلَم به يخرج (`notified_at`)، وإلا صار العدّاد أرشيفاً لا طابوراً.
 */
export async function findDemandSummary(branchId: number, limit: number) {
  return db
    .select({
      variant_id: d.variant_id,
      product_id: catalogVariantsTable.product_id,
      product_name_ar: catalogProductsTable.name_ar,
      sku: catalogVariantsTable.sku,
      notify_count: count(sql`case when ${d.kind} = 'notify' then 1 end`),
      request_count: count(sql`case when ${d.kind} = 'request_here' then 1 end`),
      first_asked_at: min(d.created_at),
      on_hand: stockBalancesTable.on_hand,
    })
    .from(d)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, d.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .leftJoin(
      stockBalancesTable,
      and(eq(stockBalancesTable.variant_id, d.variant_id), eq(stockBalancesTable.branch_id, d.branch_id)),
    )
    .where(and(eq(d.branch_id, branchId), isNull(d.notified_at)))
    .groupBy(
      d.variant_id,
      catalogVariantsTable.product_id,
      catalogProductsTable.name_ar,
      catalogVariantsTable.sku,
      stockBalancesTable.on_hand,
    )
    // الأقدم أولاً: من انتظر أطول هو من يُنسى، والأحدث-أولاً يدفن الطابور نفسه.
    .orderBy(asc(min(d.created_at)))
    .limit(limit);
}

/**
 * Open requests whose goods are on the shelf **at the branch they were asked
 * at** — the back-in-stock sweep reads this (2026-10-07).
 *
 * Only what can actually be bought there: a live branch, a published product,
 * an active variant, a live customer, and `on_hand − reserved > 0`. The price
 * is checked by the service (it comes from the pricing port, not a table).
 * Oldest first, so a long batch tells those who waited longest.
 */
export function findOpenDemandInStock(limit: number) {
  return db
    .select({
      id: d.id,
      customer_id: d.customer_id,
      variant_id: d.variant_id,
      branch_id: d.branch_id,
      product_id: catalogVariantsTable.product_id,
      product_name_ar: catalogProductsTable.name_ar,
      product_name_en: catalogProductsTable.name_en,
      branch_name: branchesTable.name,
    })
    .from(d)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, d.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .innerJoin(branchesTable, eq(branchesTable.id, d.branch_id))
    .innerJoin(customersTable, eq(customersTable.id, d.customer_id))
    .innerJoin(
      stockBalancesTable,
      and(eq(stockBalancesTable.variant_id, d.variant_id), eq(stockBalancesTable.branch_id, d.branch_id)),
    )
    .where(
      and(
        isNull(d.notified_at),
        eq(catalogVariantsTable.status, 'active'),
        isNull(catalogProductsTable.archived_at),
        eq(catalogProductsTable.status, 'active'),
        eq(catalogProductsTable.is_sellable, true),
        eq(catalogProductsTable.is_branch_draft, false),
        eq(branchesTable.status, 'active'),
        isNull(branchesTable.archived_at),
        eq(customersTable.status, 'active'),
        sql`${stockBalancesTable.on_hand} - ${stockBalancesTable.reserved} > 0`,
      ),
    )
    .orderBy(asc(d.created_at))
    .limit(limit);
}

/**
 * Marks these requests answered and returns the ones **this call** claimed.
 * The send follows the claim, so two sweeps that overlap never tell the same
 * person twice.
 */
export async function claimNotified(ids: number[], at: Date): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(d)
    .set({ notified_at: at })
    .where(and(inArray(d.id, ids), isNull(d.notified_at)))
    .returning({ id: d.id });
  return rows.map((r) => r.id);
}
