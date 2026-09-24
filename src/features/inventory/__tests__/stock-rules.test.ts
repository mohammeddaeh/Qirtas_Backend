import { describe, expect, it } from 'vitest';
import {
  adjustmentValue,
  applyIssue,
  applyReceipt,
  applyReturn,
  available,
  lineUnitCost,
  needsApproval,
  stockFlag,
  suggestThreshold,
} from '../services/stock-rules.js';

/**
 * Every wrong answer here is a plausible number: an average that drifts
 * reports a profit nobody made, a balance that ignores a reservation sells
 * the last piece twice, a cost divided by the wrong unit prices a carton as a
 * pen. Each rule is pinned with its opposite.
 */

const balance = (onHand: number, syp: number, usd = 0) => ({ onHand, avg: { syp, usd } });

describe('moving weighted average', () => {
  it('weighs the new cost against what is already there', () => {
    const after = applyReceipt(balance(10, 100), 10, { syp: 200, usd: 0 });
    expect(after.onHand).toBe(20);
    expect(after.avg.syp).toBe(150);
  });

  it('weighs by quantity, not by receipt count', () => {
    // 90 pieces at 100 and 10 at 200 is 110, not 150.
    expect(applyReceipt(balance(90, 100), 10, { syp: 200, usd: 0 }).avg.syp).toBe(110);
  });

  it('an issue moves the quantity and NOT the average', () => {
    const after = applyIssue(balance(20, 150), 5);
    expect(after.onHand).toBe(15);
    expect(after.avg.syp).toBe(150);
  });

  it('goods coming back with no new cost ADD, and leave the average alone', () => {
    // **اتجاهٌ خاطئ هنا لا يُصدر صوتاً**: مرتجعُ الزبون كان يُخصم من الرصيد
    // لأن `postMovements` كانت تقرّر بوجود التكلفة لا بالإشارة — والحركة
    // تُكتب بالقيمة الصحيحة، والرصيد وحده يذهب بالاتجاه المعاكس.
    const after = applyReturn(balance(20, 150), 5);
    expect(after.onHand).toBe(25);
    // **والمتوسط لا يتحرّك**: وزنُها بصفر يجرّه لأسفل مع كل مرتجع، فيصير
    // رفُّ محلٍّ كثير المرتجعات مقوَّماً بلا شيء.
    expect(after.avg.syp).toBe(150);
  });

  it('a return of zero or less changes nothing', () => {
    // وإثبات الإضافة وحده لا يكفي: دالّةٌ تضيف دائماً تنجح فيه، وتلك تزيد
    // الرصيد بمرتجعٍ فارغ أُلغي قبل أن يُسجَّل.
    expect(applyReturn(balance(20, 150), 0).onHand).toBe(20);
    expect(applyReturn(balance(20, 150), -3).onHand).toBe(20);
  });

  it('stock sold before its receipt was entered takes the new cost, not an average against a negative', () => {
    const after = applyReceipt(balance(-5, 100), 10, { syp: 200, usd: 0 });
    expect(after.onHand).toBe(5);
    expect(after.avg.syp).toBe(200);
  });

  it('an empty shelf takes the new cost as the average', () => {
    expect(applyReceipt(balance(0, 100), 10, { syp: 250, usd: 0 }).avg.syp).toBe(250);
  });

  it('a zero or negative quantity changes nothing', () => {
    expect(applyReceipt(balance(10, 100), 0, { syp: 999, usd: 0 })).toEqual(balance(10, 100));
    expect(applyIssue(balance(10, 100), 0)).toEqual(balance(10, 100));
  });

  it('keeps both currencies — the dollar average is what partner profit is read in', () => {
    const after = applyReceipt(balance(10, 1000, 0.1), 10, { syp: 3000, usd: 0.2 });
    expect(after.avg.syp).toBe(2000);
    expect(after.avg.usd).toBe(0.15);
  });

  it('an issue may take the balance below zero — the counter sells what it holds', () => {
    expect(applyIssue(balance(2, 100), 5).onHand).toBe(-3);
  });
});

describe('available', () => {
  it('is what is here minus what is held', () => {
    expect(available(10, 3)).toBe(7);
  });

  it('is not the same as on hand — the reservation is the whole point', () => {
    expect(available(3, 3)).toBe(0);
    expect(available(3, 5)).toBe(-2);
  });
});

describe('cost per base unit', () => {
  it('divides the purchase unit by its factor', () => {
    expect(lineUnitCost(60000, 12, 'SYP', 13000)).toEqual({ syp: 5000, usd: 0.3846 });
  });

  it('a dollar invoice converts at the invoice rate and keeps both', () => {
    expect(lineUnitCost(2.4, 12, 'USD', 13000)).toEqual({ syp: 2600, usd: 0.2 });
  });

  it('a dollar invoice with no rate is refused, not guessed', () => {
    expect(lineUnitCost(2.4, 12, 'USD', null)).toBeNull();
    expect(lineUnitCost(2.4, 12, 'USD', 0)).toBeNull();
  });

  it('a pound invoice with no rate still records the pound cost — the dollar side is zero, not invented', () => {
    expect(lineUnitCost(6000, 12, 'SYP', null)).toEqual({ syp: 500, usd: 0 });
  });

  it('a zero factor is refused rather than answered with infinity', () => {
    expect(lineUnitCost(6000, 0, 'SYP', 13000)).toBeNull();
    expect(lineUnitCost(6000, -1, 'SYP', 13000)).toBeNull();
  });
});

describe('adjustments', () => {
  it('values the lines at the average cost of the moment', () => {
    expect(adjustmentValue([{ qtyBase: 3, unitCostSyp: 500 }, { qtyBase: 2, unitCostSyp: 1000 }])).toBe(3500);
  });

  it('waits for a manager above the threshold — and not at it', () => {
    expect(needsApproval(100001, 100000)).toBe(true);
    expect(needsApproval(100000, 100000)).toBe(false);
    expect(needsApproval(0, 100000)).toBe(false);
  });
});

describe('how a balance reads', () => {
  it('negative is its own state — a contradiction, not "very low"', () => {
    expect(stockFlag(-1, 0, 10)).toBe('negative');
    expect(stockFlag(-1, 0, null)).toBe('negative');
  });

  it('nothing available reads as out of stock, even with stock held for orders', () => {
    expect(stockFlag(0, 0, 10)).toBe('out_of_stock');
    expect(stockFlag(3, 3, 10)).toBe('out_of_stock');
  });

  it('low only under a threshold the branch set — and never without one', () => {
    expect(stockFlag(5, 0, 10)).toBe('low');
    expect(stockFlag(10, 0, 10)).toBe('low');
    expect(stockFlag(11, 0, 10)).toBe('ok');
    expect(stockFlag(1, 0, null)).toBe('ok');
    expect(stockFlag(1, 0, 0)).toBe('ok');
  });
});

describe('the suggested threshold', () => {
  it('covers two weeks of the average day, rounded up', () => {
    // 300 pieces over 30 days = 10 a day → 140 for a fortnight.
    expect(suggestThreshold(300, 30)).toBe(140);
    expect(suggestThreshold(31, 30)).toBe(15); // 1.033/day → 14.47 → 15
  });

  it('says nothing when the history is too short — a guess would be trusted as a number', () => {
    expect(suggestThreshold(300, 29)).toBeNull();
    expect(suggestThreshold(0, 90)).toBeNull();
  });

  it('never suggests zero for something that sells at all', () => {
    expect(suggestThreshold(1, 365)).toBe(1);
  });
});
