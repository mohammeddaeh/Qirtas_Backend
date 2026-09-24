/**
 * What may go back to a supplier, and what it is worth — the arithmetic of
 * inventory_suppliers.md §٧, with no database in it.
 *
 * It lives apart from the service because both of its answers are wrong in
 * ways nothing reports: a cap computed one box too high is refused by nothing
 * (the return posts, the supplier is credited twice for the same box), and a
 * value taken from the shelf average instead of the invoice is a number that
 * simply differs from the supplier's statement, with no error anywhere.
 */

/** Quantities are stored to three decimals; comparisons must round the same way. */
function round3(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * How much of an invoice line is still returnable: what arrived, minus what
 * already went back on that invoice. Never negative — a clamp, not a credit.
 */
export function returnableBase(receivedBase: number, alreadyReturnedBase: number): number {
  return round3(Math.max(0, receivedBase - alreadyReturnedBase));
}

export type ReturnBlock = 'exceeds_receipt' | 'exceeds_stock' | null;

/**
 * Why a line cannot go back, in the order the two facts matter.
 *
 * The invoice is checked first: it is the stronger statement. "We never
 * bought this many from you" is true whatever the shelf holds, while "it is
 * not on the shelf" may simply mean it was sold — a different conversation.
 *
 * The epsilon is not decoration: quantities arrive as decimal strings, and
 * `3 - 1.2 - 1.8` is `0.0000000000000004`, which would refuse the last box of
 * an exactly-consumed line.
 */
export function returnBlock(qtyBase: number, returnableBase: number, availableBase: number): ReturnBlock {
  const epsilon = 1e-6;
  if (qtyBase > returnableBase + epsilon) return 'exceeds_receipt';
  if (qtyBase > availableBase + epsilon) return 'exceeds_stock';
  return null;
}

/** The credit note's total: the cost the goods came in at, never today's average. */
export function returnValue(lines: { qty_base: number; unit_cost_syp: number }[]): number {
  return Number(lines.reduce((sum, line) => sum + line.qty_base * line.unit_cost_syp, 0).toFixed(2));
}
