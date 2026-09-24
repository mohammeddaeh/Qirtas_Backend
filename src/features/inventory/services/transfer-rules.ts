import type { TransferStatus } from '../schemas/transfers.schema.js';

/**
 * What may happen to a transfer next, and how a count's differences are read
 * — inventory_suppliers.md §٤–§٥.
 *
 * Pure, because every wrong answer here is silent: an action allowed from the
 * wrong state posts stock twice (ship an already-shipped transfer and the
 * sender loses the goods again), and a difference read with the wrong sign
 * corrects a shelf in the wrong direction.
 */

const NEXT: Record<TransferStatus, TransferStatus[]> = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved: ['in_transit', 'cancelled'],
  rejected: [],
  in_transit: ['received', 'received_with_discrepancy'],
  received: ['closed'],
  received_with_discrepancy: ['closed'],
  closed: [],
  cancelled: [],
};

export function canMove(from: TransferStatus, to: TransferStatus): boolean {
  return NEXT[from].includes(to);
}

/** Which transitions a screen may offer — the server's answer, not a guess. */
export function nextStates(from: TransferStatus): TransferStatus[] {
  return [...NEXT[from]];
}

export interface TransferLineOutcome {
  variantId: number;
  shipped: number;
  received: number;
  /** Shipped minus received: positive is missing, negative is a surplus. */
  missing: number;
}

/**
 * What arrived against what left. A surplus is kept as a negative difference
 * rather than clamped to zero: three extra pieces are as wrong as three
 * missing ones, and hiding it would leave the receiving branch short on paper
 * forever.
 */
export function compareShipment(
  lines: { variantId: number; shipped: number; received: number }[],
): { lines: TransferLineOutcome[]; hasDiscrepancy: boolean } {
  const outcome = lines.map((line) => ({
    variantId: line.variantId,
    shipped: line.shipped,
    received: line.received,
    missing: Number((line.shipped - line.received).toFixed(3)),
  }));
  return { lines: outcome, hasDiscrepancy: outcome.some((line) => line.missing !== 0) };
}

export interface CountLineDiff {
  variantId: number;
  counted: number;
  system: number;
  /** Counted minus system: positive means the shelf holds more than the books. */
  diff: number;
  unitCostSyp: number;
}

/** The lines that disagree, and what the disagreement is worth (§٥). */
export function countDifferences(
  lines: { variantId: number; counted: number; system: number; unitCostSyp: number }[],
): { diffs: CountLineDiff[]; valueSyp: number } {
  const diffs = lines
    .map((line) => ({ ...line, diff: Number((line.counted - line.system).toFixed(3)) }))
    .filter((line) => line.diff !== 0);
  // Absolute value: a shortage of 10 and a surplus of 10 are two problems, not
  // zero. Netting them would let a big count slip under an approval threshold.
  const valueSyp = Number(diffs.reduce((sum, line) => sum + Math.abs(line.diff) * line.unitCostSyp, 0).toFixed(2));
  return { diffs, valueSyp };
}
