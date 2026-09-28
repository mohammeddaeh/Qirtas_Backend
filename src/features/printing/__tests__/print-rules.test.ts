import { describe, expect, it } from 'vitest';
import {
  bandOf,
  pageRateKey,
  quote,
  tierFor,
  tiersProblem,
  withinBand,
  type PrintConfig,
  type PrintOption,
  type QuoteInput,
} from '../services/print-rules.js';

/**
 * **سعر طباعة يُحسب خطأً مبلغٌ معقول يُطلب من زبون واقف.**
 *
 * خليةٌ بلا سعر تُقرأ صفراً فتُطبع مئة صفحة مجاناً · شريحتان تُجمعان فيصير
 * الخصم ١٥٪ لا ١٠٪ · الوجهان يُعدّان ورقاً كالوجه الواحد فيُحجز ضعف الورق ·
 * خيارٌ معطَّل بالفرع يُقبل فيُطلب ما لا يستطيع الفرع صنعه. ولا شيء من هذا يرمي.
 *
 * ولذلك **كل حالة مع نقيضها**: إثبات أن الفرع يسبق المركزي لا يكفي وحده
 * (دالّةٌ تُرجع سعر الفرع دائماً تنجح فيه، وتلك ترفض كل خلية لم يستثنها فرع).
 */

const A4 = 1;
const A3 = 2;
const BW = 3;
const COLOR = 4;
const SINGLE = 5;
const DOUBLE = 6;
const NO_BINDING = 7;
const SPIRAL = 8;
const NO_COVER = 9;
const SOFT_COVER = 10;

function opt(
  id: number,
  kind: PrintOption['kind'],
  code: string,
  isActive = true,
): [number, PrintOption] {
  return [id, { id, kind, code, isActive }];
}

function config(overrides: Partial<PrintConfig> = {}): PrintConfig {
  return {
    options: new Map([
      opt(A4, 'paper_size', 'a4'),
      opt(A3, 'paper_size', 'a3'),
      opt(BW, 'color_mode', 'bw'),
      opt(COLOR, 'color_mode', 'color'),
      opt(SINGLE, 'sides', 'single'),
      opt(DOUBLE, 'sides', 'double'),
      opt(NO_BINDING, 'binding', 'none'),
      opt(SPIRAL, 'binding', 'spiral'),
      opt(NO_COVER, 'cover', 'none'),
      opt(SOFT_COVER, 'cover', 'soft'),
    ]),
    disabledAtBranch: new Set(),
    centralPageRates: new Map([
      [pageRateKey(A4, BW, SINGLE), 100],
      [pageRateKey(A4, BW, DOUBLE), 80],
      [pageRateKey(A4, COLOR, SINGLE), 500],
    ]),
    branchPageRates: new Map(),
    centralFinishing: new Map([
      [NO_BINDING, 0],
      [SPIRAL, 3000],
      [NO_COVER, 0],
      [SOFT_COVER, 1000],
    ]),
    branchFinishing: new Map(),
    tiers: [],
    ...overrides,
  };
}

const base: QuoteInput = {
  pages: 10,
  copies: 1,
  paperSizeId: A4,
  colorModeId: BW,
  sidesId: SINGLE,
  bindingId: NO_BINDING,
  coverId: NO_COVER,
};

function ok(input: QuoteInput, cfg = config()) {
  const r = quote(input, cfg);
  if (!r.ok) throw new Error(`expected a quote, got ${JSON.stringify(r.refusal)}`);
  return r.quote;
}

describe('page price', () => {
  it('charges pages × copies × the cell rate', () => {
    const q = ok({ ...base, pages: 10, copies: 3 });
    expect(q.printedPages).toBe(30);
    expect(q.pagesSubtotalSyp).toBe(3000);
    expect(q.totalSyp).toBe(3000);
  });

  it('a cell with no price anywhere refuses — it is never free', () => {
    const r = quote({ ...base, paperSizeId: A3 }, config());
    expect(r).toEqual({ ok: false, refusal: { reason: 'spec_unpriced', optionId: null } });
  });

  it('the branch rate wins for its own cell', () => {
    const q = ok(base, config({ branchPageRates: new Map([[pageRateKey(A4, BW, SINGLE), 90]]) }));
    expect(q.pageRateSyp).toBe(90);
    expect(q.pageRateSource).toBe('branch');
  });

  it('…and only its own: another cell stays on the central rate', () => {
    const q = ok(
      { ...base, colorModeId: COLOR },
      config({ branchPageRates: new Map([[pageRateKey(A4, BW, SINGLE), 90]]) }),
    );
    expect(q.pageRateSyp).toBe(500);
    expect(q.pageRateSource).toBe('central');
  });

  it('a branch rate prices a cell the centre left empty', () => {
    const q = ok(
      { ...base, paperSizeId: A3 },
      config({ branchPageRates: new Map([[pageRateKey(A3, BW, SINGLE), 250]]) }),
    );
    expect(q.pageRateSyp).toBe(250);
  });
});

describe('sheets', () => {
  it('double-sided prints two pages on a sheet, and an odd page still needs a sheet', () => {
    const q = ok({ ...base, sidesId: DOUBLE, pages: 11, copies: 2 });
    expect(q.sheets).toBe(12); // ceil(11/2) × 2
    expect(q.printedPages).toBe(22); // the price is per printed page, not per sheet
  });

  it('single-sided is one sheet per page', () => {
    const q = ok({ ...base, pages: 11, copies: 2 });
    expect(q.sheets).toBe(22);
  });
});

describe('finishing', () => {
  it('is charged per copy, from the branch when it has its own', () => {
    const q = ok(
      { ...base, bindingId: SPIRAL, coverId: SOFT_COVER, copies: 2 },
      config({ branchFinishing: new Map([[SPIRAL, 2500]]) }),
    );
    const spiral = q.finishing.find((f) => f.optionId === SPIRAL)!;
    const cover = q.finishing.find((f) => f.optionId === SOFT_COVER)!;
    expect(spiral).toMatchObject({ perCopySyp: 2500, source: 'branch', subtotalSyp: 5000 });
    expect(cover).toMatchObject({ perCopySyp: 1000, source: 'central', subtotalSyp: 2000 });
    expect(q.finishingSubtotalSyp).toBe(7000);
    expect(q.totalSyp).toBe(2000 + 7000);
  });

  it('"no binding" is a priced choice (zero), and an unpriced binding refuses', () => {
    expect(ok(base).finishingSubtotalSyp).toBe(0);
    const r = quote(
      { ...base, bindingId: SPIRAL },
      config({
        centralFinishing: new Map([
          [NO_BINDING, 0],
          [NO_COVER, 0],
        ]),
      }),
    );
    expect(r).toEqual({ ok: false, refusal: { reason: 'spec_unpriced', optionId: SPIRAL } });
  });
});

describe('quantity tiers', () => {
  const tiers = [
    { minPages: 50, discountPercent: 5 },
    { minPages: 100, discountPercent: 10 },
  ];

  it('takes the highest tier reached — not the sum of tiers', () => {
    expect(tierFor(100, tiers)).toEqual({ minPages: 100, discountPercent: 10 });
    expect(tierFor(99, tiers)).toEqual({ minPages: 50, discountPercent: 5 });
  });

  it('below the first tier there is none', () => {
    expect(tierFor(49, tiers)).toBeNull();
  });

  it('counts pages × copies, and discounts the pages only — binding does not get cheaper', () => {
    const q = ok({ ...base, pages: 50, copies: 2, bindingId: SPIRAL }, config({ tiers }));
    expect(q.tier).toEqual({ minPages: 100, discountPercent: 10 });
    expect(q.pagesSubtotalSyp).toBe(10000);
    expect(q.tierDiscountSyp).toBe(1000);
    expect(q.totalSyp).toBe(10000 - 1000 + 6000);
  });

  it('rejects a zero, a full or a repeated threshold — and accepts a clean list', () => {
    expect(tiersProblem([{ minPages: 0, discountPercent: 5 }])).toBe('print_tier_invalid');
    expect(tiersProblem([{ minPages: 10, discountPercent: 100 }])).toBe('print_tier_invalid');
    expect(tiersProblem([{ minPages: 10, discountPercent: 0 }])).toBe('print_tier_invalid');
    expect(
      tiersProblem([
        { minPages: 10, discountPercent: 5 },
        { minPages: 10, discountPercent: 8 },
      ]),
    ).toBe('print_tier_duplicate');
    expect(tiersProblem(tiers)).toBeNull();
    expect(tiersProblem([])).toBeNull();
  });
});

describe('options', () => {
  it('an option disabled at the branch refuses — the branch cannot make it', () => {
    const r = quote(
      { ...base, bindingId: SPIRAL },
      config({ disabledAtBranch: new Set([SPIRAL]) }),
    );
    expect(r).toEqual({
      ok: false,
      refusal: { reason: 'option_disabled_at_branch', optionId: SPIRAL },
    });
  });

  it('…while the same option passes at a branch that did not disable it', () => {
    expect(quote({ ...base, bindingId: SPIRAL }, config()).ok).toBe(true);
  });

  it('an inactive option refuses everywhere', () => {
    const cfg = config();
    cfg.options.set(SPIRAL, { id: SPIRAL, kind: 'binding', code: 'spiral', isActive: false });
    expect(quote({ ...base, bindingId: SPIRAL }, cfg)).toEqual({
      ok: false,
      refusal: { reason: 'option_inactive', optionId: SPIRAL },
    });
  });

  it('an option of the wrong kind refuses — a binding id is not a paper size', () => {
    expect(quote({ ...base, paperSizeId: SPIRAL }, config())).toEqual({
      ok: false,
      refusal: { reason: 'option_wrong_kind', optionId: SPIRAL, expected: 'paper_size' },
    });
  });

  it('an unknown id refuses', () => {
    expect(quote({ ...base, coverId: 999 }, config())).toEqual({
      ok: false,
      refusal: { reason: 'option_unknown', optionId: 999 },
    });
  });
});

describe('branch band', () => {
  it('includes both edges', () => {
    expect(withinBand(100, 80, 20)).toBe(true);
    expect(withinBand(100, 120, 20)).toBe(true);
  });

  it('…and refuses past them either way', () => {
    expect(withinBand(100, 79.99, 20)).toBe(false);
    expect(withinBand(100, 120.01, 20)).toBe(false);
  });

  it('a zero band pins the branch to the central price', () => {
    expect(withinBand(100, 100, 0)).toBe(true);
    expect(withinBand(100, 101, 0)).toBe(false);
  });

  it('states the range as numbers', () => {
    expect(bandOf(250, 20)).toEqual({ minSyp: 200, maxSyp: 300 });
  });
});

describe('rounding', () => {
  it('the total is whole liras — a percentage never asks for half a lira', () => {
    const q = ok(
      { ...base, pages: 7, copies: 1 },
      config({
        centralPageRates: new Map([[pageRateKey(A4, BW, SINGLE), 33]]),
        tiers: [{ minPages: 5, discountPercent: 3 }],
      }),
    );
    // 231 − 6.93 = 224.07
    expect(q.tierDiscountSyp).toBe(6.93);
    expect(q.totalSyp).toBe(224);
  });
});
