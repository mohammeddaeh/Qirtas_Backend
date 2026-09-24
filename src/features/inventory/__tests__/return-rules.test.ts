import { describe, expect, it } from 'vitest';
import { returnableBase, returnBlock, returnValue } from '../services/return-rules.js';

/**
 * Every failure here is silent. A cap one box too high posts a second return
 * for goods already sent back, and the supplier is credited twice with no
 * error anywhere. A cap one box too low refuses the last box of a line and
 * reads as «the system will not let me» — the branch keeps goods it was told
 * to return. And a wrong total is simply a number that differs from the
 * supplier's statement, months later.
 *
 * So each rule is pinned with its opposite: proving that too much is refused
 * proves nothing on its own — a function that refuses everything passes it.
 */

describe('how much of an invoice line is still returnable', () => {
  it('what arrived, minus what already went back', () => {
    expect(returnableBase(12, 4)).toBe(8);
    // And the untouched line stays whole — a subtraction that ran twice
    // would show here and nowhere else.
    expect(returnableBase(12, 0)).toBe(12);
  });

  it('a fully returned line is zero, never negative', () => {
    expect(returnableBase(12, 12)).toBe(0);
    // A negative would read as a credit the supplier owes us.
    expect(returnableBase(12, 20)).toBe(0);
  });

  it('rounds to the three decimals the quantities are stored at', () => {
    expect(returnableBase(3, 1.2 + 1.8)).toBe(0);
    expect(returnableBase(2.5, 0.25)).toBe(2.25);
  });
});

describe('why a line cannot go back', () => {
  it('within the invoice and on the shelf — nothing blocks it', () => {
    expect(returnBlock(5, 8, 10)).toBeNull();
    // Exactly the whole remainder is allowed: a cap is a cap, not a limit
    // one below itself.
    expect(returnBlock(8, 8, 10)).toBeNull();
  });

  it('more than the invoice brought in is refused as an invoice problem', () => {
    expect(returnBlock(9, 8, 100)).toBe('exceeds_receipt');
    // Even with plenty on the shelf: holding the goods does not mean this
    // supplier sold them to us.
    expect(returnBlock(9, 8, 1000)).toBe('exceeds_receipt');
  });

  it('the invoice is judged before the shelf', () => {
    // Both are exceeded. The invoice answer is the true one — "we never
    // bought this many from you" — while "it is not on the shelf" may only
    // mean it was sold, which is a different conversation.
    expect(returnBlock(9, 8, 2)).toBe('exceeds_receipt');
  });

  it('within the invoice but no longer on the shelf is a stock problem', () => {
    expect(returnBlock(5, 8, 3)).toBe('exceeds_stock');
    // And the same quantity passes once the stock is there — proving the
    // block reads the balance rather than refusing on principle.
    expect(returnBlock(5, 8, 5)).toBeNull();
  });

  it('floating point leftovers do not refuse an exact line', () => {
    // 3 - 1.2 - 1.8 is 0.0000000000000004 in binary floating point.
    expect(returnBlock(3, 3 - 1.2 - 1.8 + 3, 3)).toBeNull();
    // But a real excess of one unit is still refused.
    expect(returnBlock(4, 3, 10)).toBe('exceeds_receipt');
  });
});

describe('what the return is worth', () => {
  it('quantity times the cost it came in at, per line', () => {
    expect(returnValue([{ qty_base: 10, unit_cost_syp: 500 }])).toBe(5000);
    expect(
      returnValue([
        { qty_base: 10, unit_cost_syp: 500 },
        { qty_base: 2, unit_cost_syp: 1250 },
      ]),
    ).toBe(7500);
  });

  it('an empty return is worth nothing, not NaN', () => {
    expect(returnValue([])).toBe(0);
  });

  it('rounds to piastres, so the total matches what is stored', () => {
    expect(returnValue([{ qty_base: 3, unit_cost_syp: 0.3333 }])).toBe(1);
    expect(returnValue([{ qty_base: 1.5, unit_cost_syp: 333.333 }])).toBe(500);
  });
});
