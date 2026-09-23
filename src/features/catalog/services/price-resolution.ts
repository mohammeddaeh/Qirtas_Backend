import type { PricePolicy, PricingCurrency } from '../schemas/catalog-enums.schema.js';

/**
 * How a variant's selling price at one branch is decided — store_system.md §١١.
 *
 * Pure and exhaustively tested (`__tests__/price-resolution.test.ts`): every
 * wrong answer here is a *plausible* number on a shelf. Nothing fails when the
 * branch's out-of-band price wins, or when a dollar price is rounded down — a
 * customer just pays the wrong amount.
 *
 * The client never computes a price; it shows what this returns, including
 * where the number came from.
 */

export interface Money {
  amount: number;
  currency: PricingCurrency;
}

export interface RoundingBand {
  /** Applies to prices below this (SYP). `null` = everything above the previous band. */
  below: number | null;
  step: number;
}

export const DEFAULT_ROUNDING_BANDS: readonly RoundingBand[] = [
  { below: 1000, step: 50 },
  { below: 10000, step: 100 },
  { below: null, step: 500 },
];

export type PriceSource = 'central' | 'branch' | 'branch_exception' | 'suggested';

export interface PriceInput {
  policy: PricePolicy;
  isListed: boolean;
  central: Money | null;
  branch: Money | null;
  /** `branch_banded` only: ± this percent of the central price. */
  bandPercent: number | null;
  /** SYP per USD; `null` = none recorded yet. */
  usdToSyp: number | null;
  bands: readonly RoundingBand[];
  wholesale: {
    explicit: Money | null;
    discountPercent: number | null;
    minQty: number | null;
  };
}

export type ResolvedPrice =
  | { status: 'not_listed' }
  | { status: 'unpriced'; reason: 'no_price' | 'no_exchange_rate' }
  | {
      status: 'priced';
      amountSyp: number;
      source: PriceSource;
      /** The branch's price exists but no longer fits the band — the central price is used instead. */
      outOfBand: boolean;
      band: { min: number; max: number } | null;
      wholesale: { amountSyp: number; minQty: number } | null;
    };

/**
 * Up to the band's step. Always **up**: a converted price rounded down sells
 * below what was intended, on every sale, and nobody sees it.
 * Whole-number SYP inputs already on a step stay as they are.
 */
export function roundUp(amountSyp: number, bands: readonly RoundingBand[]): number {
  const band = bands.find((b) => b.below === null || amountSyp < b.below) ?? bands[bands.length - 1];
  if (!band || band.step <= 0) return Math.ceil(amountSyp);
  // The epsilon absorbs float noise (2.4 × 1250 = 2999.9999…) so an exact
  // multiple is not pushed a whole step up.
  return Math.ceil(amountSyp / band.step - 1e-9) * band.step;
}

/**
 * To SYP. A SYP amount a person typed is kept as typed — rounding it would
 * change a price nobody asked to change. Only a computed number (converted
 * from USD) is rounded. `null` when a USD price has no rate to convert with.
 */
export function toSyp(money: Money, usdToSyp: number | null, bands: readonly RoundingBand[]): number | null {
  if (money.currency === 'SYP') return money.amount;
  if (usdToSyp === null || usdToSyp <= 0) return null;
  return roundUp(money.amount * usdToSyp, bands);
}

/** The range a `branch_banded` branch may price within, around the central price in SYP. */
export function bandOf(centralSyp: number, bandPercent: number): { min: number; max: number } {
  const delta = (centralSyp * bandPercent) / 100;
  return { min: centralSyp - delta, max: centralSyp + delta };
}

export function resolvePrice(input: PriceInput): ResolvedPrice {
  if (!input.isListed) return { status: 'not_listed' };

  const { usdToSyp, bands } = input;
  const needsRate = (m: Money | null) => m !== null && m.currency === 'USD' && (usdToSyp === null || usdToSyp <= 0);
  const centralSyp = input.central ? toSyp(input.central, usdToSyp, bands) : null;
  const branchSyp = input.branch ? toSyp(input.branch, usdToSyp, bands) : null;

  let amountSyp: number | null = null;
  let source: PriceSource = 'central';
  let outOfBand = false;
  let band: { min: number; max: number } | null = null;

  switch (input.policy) {
    case 'central_locked':
      if (branchSyp !== null) {
        amountSyp = branchSyp;
        source = 'branch_exception';
      } else {
        amountSyp = centralSyp;
        source = 'central';
      }
      break;
    case 'branch_free':
      if (branchSyp !== null) {
        amountSyp = branchSyp;
        source = 'branch';
      } else {
        amountSyp = centralSyp;
        source = 'suggested';
      }
      break;
    case 'branch_banded':
      if (centralSyp !== null && input.bandPercent !== null) band = bandOf(centralSyp, input.bandPercent);
      if (branchSyp !== null && (band === null ? centralSyp === null : withinBand(branchSyp, band))) {
        amountSyp = branchSyp;
        source = 'branch';
      } else {
        // The branch price left the band because the central price moved.
        // Said, not silently applied: the central price stands until someone
        // at the branch prices it again.
        outOfBand = branchSyp !== null;
        amountSyp = centralSyp;
        source = 'central';
      }
      break;
  }

  if (amountSyp === null) {
    const missingRate = needsRate(input.central) || needsRate(input.branch);
    return { status: 'unpriced', reason: missingRate ? 'no_exchange_rate' : 'no_price' };
  }

  return {
    status: 'priced',
    amountSyp,
    source,
    outOfBand,
    band,
    wholesale: resolveWholesale(amountSyp, input),
  };
}

function withinBand(amount: number, band: { min: number; max: number }): boolean {
  // Cent tolerance: the band edges are computed, the branch price typed.
  return amount >= band.min - 0.005 && amount <= band.max + 0.005;
}

function resolveWholesale(retailSyp: number, input: PriceInput): { amountSyp: number; minQty: number } | null {
  const { explicit, discountPercent, minQty } = input.wholesale;
  let amountSyp: number | null = null;
  if (explicit) amountSyp = toSyp(explicit, input.usdToSyp, input.bands);
  else if (discountPercent !== null && discountPercent > 0)
    amountSyp = roundUp((retailSyp * (100 - discountPercent)) / 100, input.bands);
  if (amountSyp === null) return null;
  // A "wholesale" price at or above retail is a data slip, not a discount —
  // offering it would charge a wholesale buyer more than a walk-in.
  if (amountSyp >= retailSyp) return null;
  return { amountSyp, minQty: minQty !== null && minQty > 0 ? minQty : 1 };
}

/** Bands must end open (`below: null`), climb strictly, and have positive steps. */
export function validateRoundingBands(bands: readonly RoundingBand[]): string | null {
  if (bands.length === 0) return 'empty';
  if (bands[bands.length - 1]!.below !== null) return 'last_band_must_be_open';
  let previous = 0;
  for (const [i, b] of bands.entries()) {
    if (!(b.step > 0)) return 'step_must_be_positive';
    if (i < bands.length - 1) {
      if (b.below === null || b.below <= previous) return 'bands_must_climb';
      previous = b.below;
    }
  }
  return null;
}
