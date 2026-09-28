import { describe, expect, it } from 'vitest';
import {
  basisCount,
  consumptionFor,
  reconcile,
  rulesProblem,
  splitPostable,
  type ConsumptionRule,
} from '../services/consumption-rules.js';

/**
 * كل خطأ هنا صامت: وصفةٌ تُضرب بالصفحات بدل الأوراق تُخصم ضعف الورق، وكسرٌ
 * يُقرَّب لصفر يُخفي الحبر كله، وتسويةٌ بإشارة معكوسة تُضاعف الفرق بدل أن
 * تُصلحه — والمخزون والربح يُعرضان سليمين. لذلك **كل قاعدة مع نقيضها**.
 */

// ٥٠ صفحة × نسختان، وجهان: ١٠٠ صفحة مطبوعة، ٥٠ ورقة.
const job = { sheets: 50, printedPages: 100, copies: 2 };
const A4 = 1;
const BW = 5;
const COLOR = 6;
const SPIRAL = 11;
const PAPER = 100;
const BLACK_TONER = 200;
const COLOR_TONER = 201;
const WIRE = 300;

const rules: ConsumptionRule[] = [
  { optionId: A4, variantId: PAPER, basis: 'per_sheet', qty: 1, yieldPages: null },
  { optionId: BW, variantId: BLACK_TONER, basis: 'per_printed_page', qty: null, yieldPages: 2000 },
  {
    optionId: COLOR,
    variantId: BLACK_TONER,
    basis: 'per_printed_page',
    qty: null,
    yieldPages: 4000,
  },
  {
    optionId: COLOR,
    variantId: COLOR_TONER,
    basis: 'per_printed_page',
    qty: null,
    yieldPages: 1000,
  },
  { optionId: SPIRAL, variantId: WIRE, basis: 'per_copy', qty: 1, yieldPages: null },
];

describe('basis', () => {
  it('paper counts sheets, not printed pages (double-sided halves it)', () => {
    expect(basisCount('per_sheet', job)).toBe(50);
    expect(basisCount('per_printed_page', job)).toBe(100);
  });

  it('binding counts copies; a per-job item counts once', () => {
    expect(basisCount('per_copy', job)).toBe(2);
    expect(basisCount('per_job', job)).toBe(1);
  });
});

describe('consumptionFor', () => {
  it('takes only the chosen options', () => {
    const used = consumptionFor([A4, BW], rules, job);
    expect(used.map((u) => u.variantId).sort()).toEqual([PAPER, BLACK_TONER]);
    expect(used.find((u) => u.variantId === WIRE)).toBeUndefined();
  });

  it('paper by sheets, ink by yield, binding by copy', () => {
    const used = consumptionFor([A4, BW, SPIRAL], rules, job);
    expect(used.find((u) => u.variantId === PAPER)?.qty).toBe(50);
    expect(used.find((u) => u.variantId === BLACK_TONER)?.qty).toBe(0.05);
    expect(used.find((u) => u.variantId === WIRE)?.qty).toBe(2);
  });

  it('counts pages against the yield of ink only — not against paper', () => {
    const used = consumptionFor([A4, BW], rules, job);
    expect(used.find((u) => u.variantId === BLACK_TONER)?.yieldPages).toBe(100);
    expect(used.find((u) => u.variantId === PAPER)?.yieldPages).toBe(0);
  });

  it('two options using one material make one line, not two', () => {
    // No real spec picks BW and COLOR together; the rule under test is the grouping.
    const used = consumptionFor([BW, COLOR], rules, job);
    const black = used.filter((u) => u.variantId === BLACK_TONER);
    expect(black).toHaveLength(1);
    expect(black[0]!.qty).toBe(0.075);
  });
});

describe('splitPostable — no fraction lost, none invented', () => {
  it('a single page of ink waits instead of rounding to zero', () => {
    expect(splitPostable(0.0005)).toEqual({ post: 0, remaining: 0.0005 });
  });

  it('posts whole stock steps and keeps the rest', () => {
    expect(splitPostable(0.0525)).toEqual({ post: 0.052, remaining: 0.0005 });
  });

  it('never rounds up — it would deduct what was not used yet', () => {
    expect(splitPostable(0.0019).post).toBe(0.001);
  });

  it('survives binary noise (0.003 is not posted as 0.002)', () => {
    expect(splitPostable(0.001 + 0.002).post).toBe(0.003);
  });

  it('many single pages add up to exactly what they used', () => {
    let pending = 0;
    let posted = 0;
    for (let i = 0; i < 2000; i++) {
      const r = splitPostable(pending + 1 / 2000);
      posted += r.post;
      pending = r.remaining;
    }
    expect(Math.round((posted + pending) * 1e6) / 1e6).toBe(1);
  });
});

describe('reconcile — «a new cartridge was installed»', () => {
  it('estimate too low: the missing part is consumed', () => {
    // 0.8 estimated, 0.0003 of it still pending → 0.7997 posted; one cartridge used.
    const r = reconcile({ sinceInstall: 0.8, pending: 0.0003, pagesSinceInstall: 1600, actual: 1 });
    expect(r.correction).toBe(0.2);
  });

  it('estimate too high: the extra is handed back (negative), not consumed again', () => {
    const r = reconcile({ sinceInstall: 1.25, pending: 0, pagesSinceInstall: 2500, actual: 1 });
    expect(r.correction).toBe(-0.25);
  });

  it('an exact estimate reconciles to zero', () => {
    expect(
      reconcile({ sinceInstall: 1, pending: 0, pagesSinceInstall: 2000, actual: 1 }).correction,
    ).toBe(0);
  });

  it('suggests the yield the real numbers show', () => {
    expect(
      reconcile({ sinceInstall: 0.8, pending: 0, pagesSinceInstall: 1600, actual: 1 })
        .suggestedYieldPages,
    ).toBe(1600);
    expect(
      reconcile({ sinceInstall: 0, pending: 0, pagesSinceInstall: 0, actual: 1 })
        .suggestedYieldPages,
    ).toBeNull();
  });
});

describe('rulesProblem', () => {
  const ok = { optionId: 1, variantId: 2, basis: 'per_sheet' as const, qty: 1, yieldPages: null };

  it('accepts a quantity rule and a page-yield rule', () => {
    expect(rulesProblem([ok])).toBeNull();
    expect(
      rulesProblem([{ ...ok, basis: 'per_printed_page', qty: null, yieldPages: 2000 }]),
    ).toBeNull();
  });

  it('refuses both, or neither', () => {
    expect(rulesProblem([{ ...ok, yieldPages: 2000 }])).toBe('amount_missing');
    expect(rulesProblem([{ ...ok, qty: null }])).toBe('amount_missing');
  });

  it('refuses a yield per copy — "a cartridge lasts 2000 copies" says nothing about ink', () => {
    expect(rulesProblem([{ ...ok, basis: 'per_copy', qty: null, yieldPages: 2000 }])).toBe(
      'yield_needs_page_basis',
    );
  });

  it('refuses the same option × material twice', () => {
    expect(rulesProblem([ok, { ...ok, qty: 2 }])).toBe('duplicate');
  });
});
