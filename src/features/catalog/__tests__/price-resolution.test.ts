import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUNDING_BANDS,
  resolvePrice,
  roundUp,
  toSyp,
  validateRoundingBands,
  type PriceInput,
} from '../services/price-resolution.js';

/**
 * Every wrong answer here is a plausible number on a shelf: the branch's
 * out-of-band price winning, a dollar price rounded down, a missing branch
 * price shown as "unpriced" when it should fall back to the suggestion. Each
 * rule is pinned with its opposite.
 */

const bands = DEFAULT_ROUNDING_BANDS;
const syp = (amount: number) => ({ amount, currency: 'SYP' as const });
const usd = (amount: number) => ({ amount, currency: 'USD' as const });

function input(over: Partial<PriceInput> = {}): PriceInput {
  return {
    policy: 'central_locked',
    isListed: true,
    central: syp(2500),
    branch: null,
    bandPercent: null,
    usdToSyp: 13000,
    bands,
    wholesale: { explicit: null, discountPercent: null, minQty: null },
    ...over,
  };
}

describe('rounding', () => {
  it('rounds up within each band', () => {
    expect(roundUp(310, bands)).toBe(350);
    expect(roundUp(1210, bands)).toBe(1300);
    expect(roundUp(12001, bands)).toBe(12500);
  });

  it('never rounds down — and leaves an exact step alone', () => {
    expect(roundUp(1201, bands)).toBe(1300);
    expect(roundUp(1300, bands)).toBe(1300);
    expect(roundUp(2.4 * 1250, bands)).toBe(3000); // float noise is not a step
  });

  it('the band edge belongs to the next band', () => {
    expect(roundUp(999, bands)).toBe(1000);
    expect(roundUp(1000, bands)).toBe(1000);
    expect(roundUp(10000, bands)).toBe(10000);
    expect(roundUp(10001, bands)).toBe(10500);
  });

  it('keeps a typed SYP price as typed, rounds only what it converted', () => {
    expect(toSyp(syp(2345), 13000, bands)).toBe(2345);
    expect(toSyp(usd(1.5), 13000, bands)).toBe(19500);
    expect(toSyp(usd(0.33), 13000, bands)).toBe(4300); // 4290 → up to 100
  });

  it('a dollar price with no rate converts to nothing, not zero', () => {
    expect(toSyp(usd(2), null, bands)).toBeNull();
    expect(toSyp(usd(2), 0, bands)).toBeNull();
  });

  it('validates the band list', () => {
    expect(validateRoundingBands(bands)).toBeNull();
    expect(validateRoundingBands([{ below: 1000, step: 50 }])).toBe('last_band_must_be_open');
    expect(validateRoundingBands([{ below: 1000, step: 50 }, { below: 500, step: 10 }, { below: null, step: 5 }])).toBe(
      'bands_must_climb',
    );
    expect(validateRoundingBands([{ below: null, step: 0 }])).toBe('step_must_be_positive');
    expect(validateRoundingBands([])).toBe('empty');
  });
});

describe('central_locked', () => {
  it('uses the central price', () => {
    expect(resolvePrice(input())).toMatchObject({ status: 'priced', amountSyp: 2500, source: 'central' });
  });

  it("a branch exception beats the central price, and says it's an exception", () => {
    expect(resolvePrice(input({ branch: syp(3000) }))).toMatchObject({
      amountSyp: 3000,
      source: 'branch_exception',
    });
  });

  it('no central price and no exception is unpriced', () => {
    expect(resolvePrice(input({ central: null }))).toEqual({ status: 'unpriced', reason: 'no_price' });
  });
});

describe('branch_free', () => {
  it("the branch's own price wins", () => {
    expect(resolvePrice(input({ policy: 'branch_free', branch: syp(2750) }))).toMatchObject({
      amountSyp: 2750,
      source: 'branch',
    });
  });

  it('with no branch price the central one is sold as the suggestion — not unpriced', () => {
    expect(resolvePrice(input({ policy: 'branch_free' }))).toMatchObject({
      status: 'priced',
      amountSyp: 2500,
      source: 'suggested',
    });
  });

  it('neither is unpriced', () => {
    expect(resolvePrice(input({ policy: 'branch_free', central: null }))).toMatchObject({ status: 'unpriced' });
  });
});

describe('branch_banded', () => {
  const banded = (over: Partial<PriceInput> = {}) => input({ policy: 'branch_banded', bandPercent: 10, ...over });

  it('a branch price inside the band wins, edges included', () => {
    expect(resolvePrice(banded({ branch: syp(2750) }))).toMatchObject({ amountSyp: 2750, source: 'branch', outOfBand: false });
    expect(resolvePrice(banded({ branch: syp(2250) }))).toMatchObject({ amountSyp: 2250, source: 'branch' });
  });

  it('a branch price outside the band is NOT sold — central stands, and it is flagged', () => {
    expect(resolvePrice(banded({ branch: syp(2751) }))).toMatchObject({
      amountSyp: 2500,
      source: 'central',
      outOfBand: true,
    });
  });

  it('no branch price: central, not flagged', () => {
    expect(resolvePrice(banded())).toMatchObject({ amountSyp: 2500, source: 'central', outOfBand: false });
  });

  it('reports the band so the screen can show the allowed range', () => {
    const r = resolvePrice(banded());
    expect(r.status === 'priced' && r.band).toEqual({ min: 2250, max: 2750 });
  });

  it('with no band set, a branch price cannot stand against the central one', () => {
    expect(resolvePrice(banded({ bandPercent: null, branch: syp(2600) }))).toMatchObject({
      amountSyp: 2500,
      outOfBand: true,
    });
  });
});

describe('currency', () => {
  it('a USD central price converts and rounds up', () => {
    expect(resolvePrice(input({ central: usd(0.2) }))).toMatchObject({ amountSyp: 2600 }); // 2600 exact
    expect(resolvePrice(input({ central: usd(0.21) }))).toMatchObject({ amountSyp: 2800 }); // 2730 → 2800
  });

  it('a USD price with no exchange rate is unpriced for that reason', () => {
    expect(resolvePrice(input({ central: usd(1), usdToSyp: null }))).toEqual({
      status: 'unpriced',
      reason: 'no_exchange_rate',
    });
  });
});

describe('listing', () => {
  it('withdrawn from the branch wins over any price', () => {
    expect(resolvePrice(input({ isListed: false, branch: syp(1) }))).toEqual({ status: 'not_listed' });
  });
});

describe('wholesale', () => {
  it('derives from the category discount, rounded up', () => {
    const r = resolvePrice(input({ wholesale: { explicit: null, discountPercent: 15, minQty: 12 } }));
    // 2500 × 0.85 = 2125 → 2200
    expect(r.status === 'priced' && r.wholesale).toEqual({ amountSyp: 2200, minQty: 12 });
  });

  it('an explicit wholesale price beats the discount', () => {
    const r = resolvePrice(input({ wholesale: { explicit: syp(2000), discountPercent: 15, minQty: null } }));
    expect(r.status === 'priced' && r.wholesale).toEqual({ amountSyp: 2000, minQty: 1 });
  });

  it('no discount and no explicit price: no wholesale price at all', () => {
    const r = resolvePrice(input());
    expect(r.status === 'priced' && r.wholesale).toBeNull();
  });

  it('a "wholesale" price at or above retail is dropped, not offered', () => {
    const r = resolvePrice(input({ wholesale: { explicit: syp(2500), discountPercent: null, minQty: null } }));
    expect(r.status === 'priced' && r.wholesale).toBeNull();
  });

  it('follows the branch price, not the central one', () => {
    const r = resolvePrice(
      input({ policy: 'branch_free', branch: syp(3000), wholesale: { explicit: null, discountPercent: 10, minQty: null } }),
    );
    expect(r.status === 'priced' && r.wholesale?.amountSyp).toBe(2700);
  });
});
