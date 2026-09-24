/**
 * The arithmetic of stock, as pure functions — inventory_suppliers.md §٢–§٨.
 *
 * Every mistake in this file is a *plausible* number: an average cost that
 * drifts by a few pounds reports a profit nobody made, and a balance that
 * ignores a reservation sells the last piece twice. None of it throws, so all
 * of it is pinned in `__tests__/stock-rules.test.ts`.
 */

export interface CostPair {
  syp: number;
  usd: number;
}

export interface Balance {
  onHand: number;
  avg: CostPair;
}

/** Quantities are stored to three decimals; anything finer is noise from a division. */
export const QTY_DP = 3;
const round = (value: number, dp: number): number => Number(value.toFixed(dp));
export const roundQty = (qty: number): number => round(qty, QTY_DP);

/**
 * The moving weighted average after goods arrive (§٣).
 *
 * Only a receipt moves the average. An issue (a sale, damage, a transfer out)
 * leaves it exactly where it was — that is what "weighted average" means, and
 * recomputing it on the way out would make the cost of what is left depend on
 * what was sold.
 *
 * Two guards, both for states a shop really reaches:
 * - stock at or below zero (sold before the receipt was entered) → the new
 *   cost simply becomes the average, because averaging against a negative
 *   quantity produces a number with no meaning.
 * - a receipt of zero or less → nothing changes.
 */
export function applyReceipt(balance: Balance, qty: number, cost: CostPair): Balance {
  if (qty <= 0) return balance;
  const onHand = roundQty(balance.onHand + qty);
  if (balance.onHand <= 0) return { onHand, avg: { syp: round(cost.syp, 2), usd: round(cost.usd, 4) } };
  const weigh = (before: number, incoming: number, dp: number): number =>
    round((balance.onHand * before + qty * incoming) / (balance.onHand + qty), dp);
  return {
    onHand,
    avg: { syp: weigh(balance.avg.syp, cost.syp, 2), usd: weigh(balance.avg.usd, cost.usd, 4) },
  };
}

/**
 * Goods coming back that carry **no new cost**: a customer return, a
 * stocktaking surplus.
 *
 * The quantity rises and the average does **not** move — these pieces were
 * always ours, bought at the average already recorded. Weighing them in at
 * zero would drag the average down with every return, and a shop with many
 * returns would end up valuing its shelf at nothing.
 */
export function applyReturn(balance: Balance, qty: number): Balance {
  if (qty <= 0) return balance;
  return { onHand: roundQty(balance.onHand + qty), avg: balance.avg };
}

/** Goods leaving: the quantity drops, the average does not. May go negative (§٨). */
export function applyIssue(balance: Balance, qty: number): Balance {
  if (qty <= 0) return balance;
  return { onHand: roundQty(balance.onHand - qty), avg: balance.avg };
}

/** What may still be sold: what is here minus what confirmed orders are holding. */
export function available(onHand: number, reserved: number): number {
  return roundQty(onHand - reserved);
}

/**
 * A branch's unit cost for one line of a purchase invoice, in both currencies.
 *
 * The invoice is priced per *purchase unit* (a carton), and stock counts base
 * units (pieces), so the cost is divided by the factor. A factor of zero would
 * divide by nothing; it is refused at the edge, and answered here with zero
 * rather than `Infinity`, which would poison the average forever.
 */
export function lineUnitCost(
  unitCost: number,
  factor: number,
  currency: 'SYP' | 'USD',
  usdToSyp: number | null,
): CostPair | null {
  if (factor <= 0) return null;
  const perBase = unitCost / factor;
  if (currency === 'SYP') {
    // With no rate, the dollar cost is recorded as zero rather than guessed:
    // an invented rate would follow the average for the life of the stock.
    return { syp: round(perBase, 2), usd: usdToSyp && usdToSyp > 0 ? round(perBase / usdToSyp, 4) : 0 };
  }
  if (!usdToSyp || usdToSyp <= 0) return null;
  return { syp: round(perBase * usdToSyp, 2), usd: round(perBase, 4) };
}

/** The value a manager approves or waves through — at the average cost of the moment (§٨). */
export function adjustmentValue(lines: { qtyBase: number; unitCostSyp: number }[]): number {
  return round(
    lines.reduce((sum, line) => sum + line.qtyBase * line.unitCostSyp, 0),
    2,
  );
}

/** Above the configured value an adjustment waits for a manager; at or below it, it posts. */
export function needsApproval(valueSyp: number, thresholdSyp: number): boolean {
  return valueSyp > thresholdSyp;
}

export type StockFlag = 'negative' | 'out_of_stock' | 'low' | 'ok';

/**
 * How a balance reads on a shelf list. `negative` first and on its own: it is
 * not "very low", it is a contradiction — the count says less than nothing —
 * and it asks for a stocktake rather than a purchase order.
 */
export function stockFlag(onHand: number, reserved: number, threshold: number | null): StockFlag {
  if (onHand < 0) return 'negative';
  const free = available(onHand, reserved);
  if (free <= 0) return 'out_of_stock';
  if (threshold !== null && threshold > 0 && free <= threshold) return 'low';
  return 'ok';
}

/**
 * A reorder threshold suggested from how fast the item actually sells: cover
 * [coverDays] of the average day, rounded up to a whole unit, at least 1.
 *
 * `null` while there is not enough history — a suggestion from three days of
 * sales is a guess wearing a number's clothes, and the branch would trust it.
 */
export function suggestThreshold(soldBase: number, days: number, coverDays = 14, minDays = 30): number | null {
  if (days < minDays || soldBase <= 0) return null;
  return Math.max(1, Math.ceil((soldBase / days) * coverDays));
}
