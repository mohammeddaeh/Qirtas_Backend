import { describe, expect, it } from 'vitest';
import { cashWithDollars, expectedUsd, ratesInOrder, roundTo } from '../fx-rules.js';

describe('dollars at the till — the change is liras, rounded, and nothing is lost', () => {
  it('a $20 note for a 250,000 bill at 13,200 gives 14,000 back — nothing rounded', () => {
    const r = cashWithDollars({ cashDueSyp: 250_000, tenderedUsd: 20, tenderedSyp: 0, rate: 13_200, roundStep: 100 });
    expect(r.usdValueSyp).toBe(264_000);
    expect(r.changeSyp).toBe(14_000);
    expect(r.roundingSyp).toBe(0);
    expect(r.short).toBe(false);
  });

  it('the change rounds to the nearest 100 — and the rest is named, not lost', () => {
    // 20 × 13,152.5 = 263,050 → excess 13,050 → 13,100 back (half up), the shop gave 50.
    const r = cashWithDollars({ cashDueSyp: 250_000, tenderedUsd: 20, tenderedSyp: 0, rate: 13_152.5, roundStep: 100 });
    expect(r.changeSyp).toBe(13_100);
    expect(r.roundingSyp).toBe(-50);
    // Below half it rounds down and the shop keeps it: excess 14,040 → 14,000 back.
    const kept = cashWithDollars({ cashDueSyp: 249_960, tenderedUsd: 20, tenderedSyp: 0, rate: 13_200, roundStep: 100 });
    expect(kept.changeSyp).toBe(14_000);
    expect(kept.roundingSyp).toBe(40);
  });

  it('dollars and liras together — the liras count toward the bill', () => {
    const r = cashWithDollars({ cashDueSyp: 250_000, tenderedUsd: 10, tenderedSyp: 120_000, rate: 13_200, roundStep: 100 });
    expect(r.changeSyp).toBe(2_000);
    expect(r.short).toBe(false);
  });

  it('a few liras short of the bill rounds in the customer favour — a real shortfall is refused', () => {
    const near = cashWithDollars({ cashDueSyp: 264_040, tenderedUsd: 20, tenderedSyp: 0, rate: 13_200, roundStep: 100 });
    expect(near.short).toBe(false);
    expect(near.changeSyp).toBe(0);
    expect(near.roundingSyp).toBe(-40);
    const far = cashWithDollars({ cashDueSyp: 270_000, tenderedUsd: 20, tenderedSyp: 0, rate: 13_200, roundStep: 100 });
    expect(far.short).toBe(true);
  });

  it('no rounding step pays to the piastre', () => {
    const r = cashWithDollars({ cashDueSyp: 250_040, tenderedUsd: 20, tenderedSyp: 0, rate: 13_200, roundStep: 0 });
    expect(r.changeSyp).toBe(13_960);
    expect(r.roundingSyp).toBe(0);
  });

  it('the change plus the rounding is always the excess', () => {
    for (const due of [100_000, 199_950, 263_999, 264_001]) {
      const r = cashWithDollars({ cashDueSyp: due, tenderedUsd: 20, tenderedSyp: 0, rate: 13_200, roundStep: 100 });
      if (!r.short) expect(r.changeSyp + r.roundingSyp).toBeCloseTo(264_000 - due, 2);
    }
  });
});

describe('roundTo', () => {
  it('rounds half up to the step — and a zero step leaves the piastres', () => {
    expect(roundTo(13_050, 100)).toBe(13_100);
    expect(roundTo(13_049, 100)).toBe(13_000);
    expect(roundTo(13_049.5, 0)).toBe(13_049.5);
  });
});

describe('rates', () => {
  it('buy at or below sell — never above, never zero', () => {
    expect(ratesInOrder(13_100, 13_300)).toBe(true);
    expect(ratesInOrder(13_200, 13_200)).toBe(true);
    expect(ratesInOrder(13_400, 13_300)).toBe(false);
    expect(ratesInOrder(0, 13_300)).toBe(false);
  });
});

describe('the drawer dollars — notes, never their value', () => {
  it('sums dollar entries by their notes and leaves the liras out', () => {
    const usd = expectedUsd(50, [
      { type: 'sale_revenue', currency: 'USD', amountFx: 20 },
      { type: 'sale_revenue', currency: 'SYP', amountFx: null },
      { type: 'cash_out', currency: 'USD', amountFx: -10 },
    ]);
    expect(usd).toBe(60);
  });

  it('the count over/short is not part of what the drawer should hold', () => {
    expect(expectedUsd(0, [{ type: 'cash_short', currency: 'USD', amountFx: -5 }])).toBe(0);
  });
});
