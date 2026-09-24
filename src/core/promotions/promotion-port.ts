/**
 * "Is anything on offer for this, here, now?" — asked from the pricing path.
 *
 * The catalogue owns the price (`core/pricing`), and promotions own what comes
 * off it. Neither may import the other (`features/CLAUDE.md`), and the answer
 * must be **one** answer: a second copy of «أي عرض يسود» disagrees with the
 * first the day either moves, and the disagreement shows as a plausible number
 * on a shelf with nothing failing.
 *
 * So promotions register the resolver and the catalogue asks the port — the
 * same shape as `core/pricing` and `core/records/deletion-guards`.
 */

export interface PromotionPriceContext {
  branchId: number;
  channel: 'online' | 'pos';
  segment: 'retail' | 'wholesale';
}

/** One row the pricing path wants an offer for, with the price it would pay otherwise. */
export interface PromotionPriceItem {
  variantId: number;
  productId: number;
  categoryId: number | null;
  brandId: number | null;
  basePriceSyp: number;
}

/**
 * What a customer actually pays, and what it was.
 *
 * Both numbers travel: a discounted price alone cannot be shown as a discount,
 * and a client that re-derives the original by dividing is a second copy of
 * the rule — the thing this port exists to prevent.
 */
export interface PromotionOnPrice {
  variantId: number;
  beforeSyp: number;
  afterSyp: number;
  /** Named so the shelf can say **why** it is cheaper. */
  names: string[];
  promotionIds: number[];
}

export type PromotionResolver = (
  ctx: PromotionPriceContext,
  items: PromotionPriceItem[],
) => Promise<Map<number, PromotionOnPrice>>;

let resolver: PromotionResolver | null = null;

export function registerPromotionResolver(fn: PromotionResolver): void {
  resolver = fn;
}

/** Test seam — module state, and a test that swaps the resolver must restore it. */
export function clearPromotionResolver(): void {
  resolver = null;
}

/**
 * Offers on these prices. With no resolver registered the map comes back
 * **empty**, and every caller reads that as «لا عرض» — a server shipped
 * without the promotions module sells at the listed price rather than
 * discounting by a rule nobody can read.
 */
export async function resolvePromotionsOn(
  ctx: PromotionPriceContext,
  items: PromotionPriceItem[],
): Promise<Map<number, PromotionOnPrice>> {
  if (items.length === 0 || resolver === null) return new Map();
  return resolver(ctx, items);
}
