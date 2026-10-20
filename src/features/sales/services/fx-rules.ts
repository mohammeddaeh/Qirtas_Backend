/**
 * Dollars at the till — `docs/reference/finance_operations.md` §٣-ب/§٣-ج.
 * Pure, so the change a customer gets back can be pinned by a test.
 */

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** To the nearest [step] liras (half up). `0` = to the piastre. */
export function roundTo(valueSyp: number, step: number): number {
  if (step <= 0) return round2(valueSyp);
  return Math.round(valueSyp / step) * step;
}

export interface CashWithDollars {
  /** What the dollars are worth at the buy rate. */
  usdValueSyp: number;
  /** Change handed back, in liras, rounded by the shop's rule. */
  changeSyp: number;
  /**
   * What rounding left with the shop: positive = the shop kept a little, negative
   * = it gave a little. Booked by its name, never lost inside the change.
   */
  roundingSyp: number;
  /** The cash handed over does not cover what is due, even after rounding. */
  short: boolean;
}

/**
 * The cash part of a bill paid with dollars (and maybe liras). The change is
 * **always liras**, rounded to [roundStep]; a customer a few liras short of a
 * round change is not sent away — rounding goes both ways.
 */
export function cashWithDollars(input: {
  cashDueSyp: number;
  tenderedUsd: number;
  tenderedSyp: number;
  rate: number;
  roundStep: number;
}): CashWithDollars {
  const usdValueSyp = round2(input.tenderedUsd * input.rate);
  const excess = round2(usdValueSyp + input.tenderedSyp - input.cashDueSyp);
  const changeSyp = Math.max(0, roundTo(excess, input.roundStep));
  return {
    usdValueSyp,
    changeSyp,
    roundingSyp: round2(excess - changeSyp),
    short: excess < 0 && roundTo(excess, input.roundStep) < 0,
  };
}

/** Rates are written buy ≤ sell — the shop never buys a dollar dearer than it sells one. */
export const ratesInOrder = (buy: number, sell: number): boolean => buy > 0 && sell > 0 && buy <= sell;

/** A dollar entry of the drawer — its notes, not their value. */
export interface UsdCashEntry {
  type: string;
  currency: string;
  amountFx: number | null;
}

/**
 * The dollars the drawer should hold: what the opener counted, plus every
 * dollar entry of the shift. The count's own over/short is the answer to this
 * sum, so it is left out — as for the liras.
 */
export function expectedUsd(openingCountedUsd: number, entries: UsdCashEntry[]): number {
  const moved = entries
    .filter((e) => e.currency === 'USD' && e.type !== 'cash_over' && e.type !== 'cash_short')
    .reduce((sum, e) => sum + (e.amountFx ?? 0), 0);
  return round2(openingCountedUsd + moved);
}
