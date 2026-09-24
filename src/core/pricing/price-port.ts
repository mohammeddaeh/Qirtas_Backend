/**
 * "What does this cost at this branch?" asked across module lines.
 *
 * The price is the catalog's answer — policy inheritance, the branch's own
 * price or the central one, the dollar rate, the rounding bands and the
 * wholesale line all live there (`store_system.md` §١١). The storefront needs
 * that answer for every row it shows, and a feature may not import another
 * feature (`features/CLAUDE.md`). A second implementation would be worse than
 * the import: two price rules disagree the first time either moves, and the
 * disagreement shows as a plausible number on a shelf with nothing failing.
 *
 * So the catalog registers the resolver and everyone else asks the port —
 * the same shape as `core/audit` and `core/records/deletion-guards`.
 */

export interface StorePrice {
  variantId: number;
  /**
   * `not_listed` — withdrawn from this branch · `unpriced` — nobody priced it
   * (or a dollar price has no rate) · `priced` — a number to show.
   *
   * `unpriced` is **never shown to a customer as itself** (§٨): it is an
   * internal fault, not a fact about the goods, and the storefront treats it
   * as "not available here" while the administration gets the signal.
   */
  status: 'priced' | 'unpriced' | 'not_listed';
  amountSyp: number | null;
  /** Only for a buyer the administration approved for wholesale. */
  wholesale: { amountSyp: number; minQty: number } | null;
  /** The category's effective rate, for a receipt that must show it. */
  taxPercent: number | null;
  /**
   * What a live offer took off, and what the price was before it
   * (`store_system.md` §٥). `null` = no offer, which is not the same as an
   * offer worth zero: a shelf that says «خصم ٠ ل.س» reads as a promotion and
   * sends somebody looking for it.
   *
   * Both numbers travel because a discounted price alone cannot be *shown* as
   * a discount, and a client that divides to recover the original is a second
   * copy of the rule.
   */
  promotion: { beforeSyp: number; names: string[]; promotionIds: number[] } | null;
}

/**
 * Who is being priced, and **whether offers apply at all**.
 *
 * `promotions` is required on purpose. The loss guard and the basket preview
 * need the price *before* any offer — they apply offers themselves — and a
 * default would silently double-discount there, or silently under-discount on
 * the shelf. Neither failure raises anything; the compiler asking each caller
 * to say which it means is the only thing that catches it.
 */
export interface PriceContext {
  promotions: 'apply' | 'ignore';
  channel: 'online' | 'pos';
  segment: 'retail' | 'wholesale';
}

export type PriceResolver = (
  branchId: number,
  variantIds: number[],
  ctx: PriceContext,
) => Promise<Map<number, StorePrice>>;

let resolver: PriceResolver | null = null;

export function registerPriceResolver(fn: PriceResolver): void {
  resolver = fn;
}

/** Test seam — module state, and a test that swaps the resolver must restore it. */
export function clearPriceResolver(): void {
  resolver = null;
}

/**
 * Prices for these variants at this branch.
 *
 * With no resolver registered the map comes back **empty**, and every caller
 * reads that as «لا سعر» — a server shipped without the catalog shows nothing
 * for sale rather than showing goods at a price nobody set.
 */
export async function resolvePricesAt(
  branchId: number,
  variantIds: number[],
  ctx: PriceContext,
): Promise<Map<number, StorePrice>> {
  if (variantIds.length === 0 || resolver === null) return new Map();
  return resolver(branchId, variantIds, ctx);
}
