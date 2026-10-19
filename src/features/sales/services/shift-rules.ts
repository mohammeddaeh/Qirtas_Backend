/**
 * The cash shift's arithmetic — `docs/reference/cash_shifts.md`. Pure, so every
 * rule the drawer is judged by can be pinned by a test without a database.
 */

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** A cash-method ledger entry stamped with the shift. */
export interface ShiftCashEntry {
  type: string;
  amountSyp: number;
}

/**
 * What the drawer should hold: what the opener counted, plus every cash
 * movement booked in the shift (sales in, refunds out, hand movements, debt
 * paid in cash). **The count's own over/short is not part of it** — it is the
 * answer to this sum, and adding it would make every drawer balance.
 */
export function expectedCash(openingCountedSyp: number, entries: ShiftCashEntry[]): number {
  const moved = entries
    .filter((e) => e.type !== 'cash_over' && e.type !== 'cash_short')
    .reduce((sum, e) => sum + e.amountSyp, 0);
  return round2(openingCountedSyp + moved);
}

/** counted − expected: positive over, negative short. */
export const differenceOf = (countedSyp: number, expectedSyp: number): number => round2(countedSyp - expectedSyp);

/**
 * Whether a difference asks for a reason. `null` threshold = never asks. **At
 * the threshold it does not ask** — the manager wrote «above».
 */
export function needsReason(differenceSyp: number, thresholdSyp: number | null): boolean {
  if (thresholdSyp === null) return false;
  return Math.abs(differenceSyp) > thresholdSyp;
}

/** Open longer than the alert — flagged, never closed by the machine. */
export function isStale(openedAt: Date, alertHours: number, now: Date = new Date()): boolean {
  return now.getTime() - openedAt.getTime() > alertHours * 3_600_000;
}

/** Whole hours a shift has been open. */
export const hoursOpen = (openedAt: Date, now: Date = new Date()): number =>
  Math.max(0, Math.floor((now.getTime() - openedAt.getTime()) / 3_600_000));

/**
 * What leaves for the safe at close. What is left in the drawer cannot be more
 * than was counted — the caller refuses that before it reaches here.
 */
export const depositedOf = (countedSyp: number, leftSyp: number): number => round2(countedSyp - leftSyp);

/**
 * The opening difference: what the opener found against what the last close
 * left. `null` when nothing was left on record — the first shift of a drawer
 * has nothing to differ from.
 */
export function openingDifference(suggestedSyp: number | null, countedSyp: number): number | null {
  if (suggestedSyp === null) return null;
  return round2(countedSyp - suggestedSyp);
}

// ── The branch drawer (`cash_shifts.md` §المرحلة الثانية) ──────────────────

/** The reasons a close's difference is given with — codes the reports group by. */
export const SHIFT_REASON_CODES = ['change_error', 'unrecorded_expense', 'count_error', 'other'] as const;
export type ShiftReasonCode = (typeof SHIFT_REASON_CODES)[number];

/** A difference past the review threshold is flagged for the manager. `null` = never. At it, not flagged. */
export function needsReview(differenceSyp: number, thresholdSyp: number | null): boolean {
  if (thresholdSyp === null) return false;
  return Math.abs(differenceSyp) > thresholdSyp;
}

/** A cash-out above the cap needs a manager. `null` cap = never. At the cap, no approval. */
export function cashOutNeedsApproval(amountSyp: number, capSyp: number | null): boolean {
  if (capSyp === null) return false;
  return amountSyp > capSyp;
}

/** Nothing leaves the drawer that is not in it — by the server's own sum. */
export const cashOutFits = (amountSyp: number, expectedSyp: number): boolean => round2(amountSyp) <= round2(expectedSyp);

/** Past the alert hours with the setting on `block`, the branch takes no money until the shift is closed. */
export function blocksMoney(openedAt: Date, alertHours: number, staleAction: 'warn' | 'block', now: Date = new Date()): boolean {
  return staleAction === 'block' && isStale(openedAt, alertHours, now);
}

/** One ledger entry of the shift, with who booked it and from which device. */
export interface ShiftPersonEntry {
  userId: number | null;
  stationId: number | null;
  type: string;
  method: string;
  amountSyp: number;
}

export interface ShiftPersonLine {
  userId: number | null;
  stationId: number | null;
  /** Everything sold, every method. */
  salesSyp: number;
  /** The cash part of it — what went into the drawer. */
  cashSalesSyp: number;
  /** Paid back, every method — positive. */
  refundsSyp: number;
  cashInSyp: number;
  /** Taken out by hand — positive. */
  cashOutSyp: number;
  debtPaymentsSyp: number;
}

/**
 * Who did what in the branch's drawer — a line per person **and device** (the
 * manager on a phone and at a computer is two lines). The count's own over/short
 * and value entries are nobody's doing and are left out.
 */
export function byPerson(entries: ShiftPersonEntry[]): ShiftPersonLine[] {
  const lines = new Map<string, ShiftPersonLine>();
  for (const e of entries) {
    if (e.method === 'value' || e.type === 'cash_over' || e.type === 'cash_short') continue;
    const key = `${e.userId ?? 0}:${e.stationId ?? 0}`;
    const line = lines.get(key) ?? {
      userId: e.userId,
      stationId: e.stationId,
      salesSyp: 0,
      cashSalesSyp: 0,
      refundsSyp: 0,
      cashInSyp: 0,
      cashOutSyp: 0,
      debtPaymentsSyp: 0,
    };
    switch (e.type) {
      case 'sale_revenue':
        line.salesSyp = round2(line.salesSyp + e.amountSyp);
        if (e.method === 'cash') line.cashSalesSyp = round2(line.cashSalesSyp + e.amountSyp);
        break;
      case 'refund':
        line.refundsSyp = round2(line.refundsSyp - e.amountSyp);
        break;
      case 'cash_in':
        line.cashInSyp = round2(line.cashInSyp + e.amountSyp);
        break;
      case 'cash_out':
        line.cashOutSyp = round2(line.cashOutSyp - e.amountSyp);
        break;
      case 'debt_payment':
        line.debtPaymentsSyp = round2(line.debtPaymentsSyp + e.amountSyp);
        break;
      default:
        continue;
    }
    lines.set(key, line);
  }
  // The biggest seller first — the question the table answers.
  return [...lines.values()].sort((a, b) => b.salesSyp - a.salesSyp);
}
