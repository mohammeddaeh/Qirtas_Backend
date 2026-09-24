import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { registerCostResolver } from '../../../core/costing/cost-port.js';
import { stockBalancesTable } from '../schemas/stock.schema.js';

/**
 * The ledger's answer to "what did this cost us", handed to the port.
 *
 * **A balance row with no goods behind it has no cost.** `avg_cost_syp`
 * defaults to `'0'`, so a variant that was created and never received reads
 * zero — and zero compares as «كل سعر خسارة» to the loss guard. The row is
 * mapped to `null` in that case: unknown is not free.
 *
 * With `branchId: null` the cost is averaged across the branches that hold it,
 * **weighted by what each holds** — a central promotion sells everywhere, and
 * a plain average lets one kiosk with three pieces outvote the main warehouse.
 */
export function installInventoryCostResolver(): void {
  registerCostResolver(async (branchId, variantIds) => {
    const out = new Map<number, number | null>();
    if (variantIds.length === 0) return out;

    const onHand = sql<string>`GREATEST(${stockBalancesTable.on_hand}, 0)`;
    const rows = await db
      .select({
        variant_id: stockBalancesTable.variant_id,
        // الوزن بما يحمله كل فرع؛ وفروعٌ كلها بصفر رصيد تسقط للمتوسط البسيط
        // بدل أن تقسم على صفر وتُرجع «لا تكلفة» لبضاعة لها تكلفة معروفة.
        cost: sql<string>`CASE
          WHEN SUM(${onHand}) > 0
            THEN SUM(${stockBalancesTable.avg_cost_syp} * ${onHand}) / SUM(${onHand})
          ELSE AVG(NULLIF(${stockBalancesTable.avg_cost_syp}, 0))
        END`,
      })
      .from(stockBalancesTable)
      .where(
        branchId === null
          ? inArray(stockBalancesTable.variant_id, variantIds)
          : and(
              inArray(stockBalancesTable.variant_id, variantIds),
              eq(stockBalancesTable.branch_id, branchId),
            ),
      )
      .groupBy(stockBalancesTable.variant_id);

    for (const row of rows) {
      const cost = row.cost === null ? 0 : Number(row.cost);
      out.set(row.variant_id, Number.isFinite(cost) && cost > 0 ? cost : null);
    }
    return out;
  });
}
