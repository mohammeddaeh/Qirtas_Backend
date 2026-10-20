/**
 * Debt rules (`finance_operations.md` §١) — pure, so the list, the account and
 * the till's on-account check all answer from one place.
 */

export interface LedgerMove {
  amount: number;
  at: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the oldest debt still unpaid was taken — first in, first out: a payment
 * settles the oldest charge first, and credit held before a charge is spent on
 * it. `null` when nothing is owed.
 *
 * The age a reader needs is «since when has this been owed», not «since the
 * first sale on account»: a customer who paid last month's bill and bought
 * yesterday owes for one day, not thirty.
 */
export function oldestUnpaidAt(moves: LedgerMove[]): Date | null {
  const owed: { at: Date; left: number }[] = [];
  let credit = 0;
  for (const m of moves) {
    if (m.amount < 0) {
      let charge = -m.amount;
      const used = Math.min(credit, charge);
      credit -= used;
      charge -= used;
      if (charge > 1e-9) owed.push({ at: m.at, left: charge });
    } else if (m.amount > 0) {
      let pay = m.amount;
      while (pay > 1e-9 && owed.length > 0) {
        const first = owed[0]!;
        const used = Math.min(first.left, pay);
        first.left -= used;
        pay -= used;
        if (first.left <= 1e-9) owed.shift();
      }
      credit += pay;
    }
  }
  return owed[0]?.at ?? null;
}

/** Whole days since [at] — 0 for today. */
export function daysSince(at: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY_MS));
}

/**
 * Whether a new on-account sale is stopped: the oldest unpaid debt is older
 * than the admin's limit. No limit, or nothing owed, never stops.
 */
export function creditOverdue(
  oldest: Date | null,
  blockAfterDays: number | null,
  now: Date = new Date(),
): boolean {
  if (oldest === null || blockAfterDays === null) return false;
  return daysSince(oldest, now) > blockAfterDays;
}

/**
 * What a payment does against what is owed: the part that settles the debt,
 * and what is left over — refused or kept as credit, by the shop's setting.
 */
export function splitPayment(amount: number, balance: number): { settles: number; extra: number } {
  const debt = Math.max(0, -balance);
  const settles = Math.min(amount, debt);
  return { settles, extra: Math.max(0, amount - settles) };
}
