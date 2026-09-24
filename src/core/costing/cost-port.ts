/**
 * "What did this cost us at this branch?" — asked from outside the warehouse.
 *
 * The weighted average cost is the inventory's answer (`inventory_suppliers.md`
 * §٤): it moves with every receipt, every return and every transfer, and it is
 * kept per branch because the same goods arrive at different prices.
 *
 * The loss guard on a promotion (`store_system.md` §٥) needs that number, and
 * promotions may not import inventory. A second computation would be worse
 * than the import — a guard that reads a stale or differently-weighted cost
 * stays quiet on exactly the sale it exists to flag.
 *
 * **A missing cost is `null`, never `0`.** Goods never received have no cost,
 * and comparing them against zero marks every offer on them a loss — a panel
 * that warns always is a panel nobody reads.
 */

export type CostResolver = (
  branchId: number | null,
  variantIds: number[],
) => Promise<Map<number, number | null>>;

let resolver: CostResolver | null = null;

export function registerCostResolver(fn: CostResolver): void {
  resolver = fn;
}

/** Test seam — module state, and a test that swaps the resolver must restore it. */
export function clearCostResolver(): void {
  resolver = null;
}

/**
 * Average cost per variant in SYP. `branchId: null` averages across branches —
 * what a central promotion is judged against, since it sells everywhere.
 *
 * With no resolver registered the map comes back **empty**, which every caller
 * reads as «لا تكلفة معروفة»: the guard stays silent rather than inventing a
 * loss out of a module that is not installed.
 */
export async function resolveAvgCostAt(
  branchId: number | null,
  variantIds: number[],
): Promise<Map<number, number | null>> {
  if (variantIds.length === 0 || resolver === null) return new Map();
  return resolver(branchId, variantIds);
}
