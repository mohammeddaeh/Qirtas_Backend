import { describe, expect, it } from 'vitest';
import { canMove, compareShipment, countDifferences, nextStates } from '../services/transfer-rules.js';

/**
 * Silent failures, all of them: a transition allowed from the wrong state
 * ships the same goods twice, a surplus clamped to zero leaves a branch short
 * on paper forever, and netted differences slip a big count under the
 * approval threshold. Each rule with its opposite.
 */

describe('what may happen next to a transfer', () => {
  it('a request is approved, rejected or cancelled — never shipped straight away', () => {
    expect(canMove('requested', 'approved')).toBe(true);
    expect(canMove('requested', 'rejected')).toBe(true);
    expect(canMove('requested', 'in_transit')).toBe(false);
  });

  it('only an approved transfer ships, and only once', () => {
    expect(canMove('approved', 'in_transit')).toBe(true);
    expect(canMove('in_transit', 'in_transit')).toBe(false);
  });

  it('receiving is the only way out of transit — in either shape', () => {
    expect(canMove('in_transit', 'received')).toBe(true);
    expect(canMove('in_transit', 'received_with_discrepancy')).toBe(true);
    expect(canMove('in_transit', 'cancelled')).toBe(false);
  });

  it('a finished transfer is finished', () => {
    for (const from of ['closed', 'rejected', 'cancelled'] as const) {
      expect(nextStates(from)).toEqual([]);
    }
  });

  it('a discrepancy closes only after it is settled', () => {
    expect(canMove('received_with_discrepancy', 'closed')).toBe(true);
    expect(canMove('received', 'closed')).toBe(true);
  });
});

describe('what arrived against what left', () => {
  it('equal quantities are no discrepancy', () => {
    const r = compareShipment([{ variantId: 1, shipped: 10, received: 10 }]);
    expect(r.hasDiscrepancy).toBe(false);
    expect(r.lines[0]!.missing).toBe(0);
  });

  it('a shortage is positive and IS a discrepancy', () => {
    const r = compareShipment([{ variantId: 1, shipped: 10, received: 8 }]);
    expect(r.lines[0]!.missing).toBe(2);
    expect(r.hasDiscrepancy).toBe(true);
  });

  it('a surplus is kept as a negative difference, not swallowed', () => {
    const r = compareShipment([{ variantId: 1, shipped: 10, received: 12 }]);
    expect(r.lines[0]!.missing).toBe(-2);
    expect(r.hasDiscrepancy).toBe(true);
  });

  it('one wrong line among right ones still flags the shipment', () => {
    const r = compareShipment([
      { variantId: 1, shipped: 5, received: 5 },
      { variantId: 2, shipped: 5, received: 4 },
    ]);
    expect(r.hasDiscrepancy).toBe(true);
  });
});

describe('a count’s differences', () => {
  const line = (variantId: number, counted: number, system: number, unitCostSyp = 1000) => ({
    variantId,
    counted,
    system,
    unitCostSyp,
  });

  it('keeps only the lines that disagree', () => {
    const r = countDifferences([line(1, 10, 10), line(2, 8, 10)]);
    expect(r.diffs.map((d) => d.variantId)).toEqual([2]);
    expect(r.diffs[0]!.diff).toBe(-2);
  });

  it('a surplus is a difference too', () => {
    const r = countDifferences([line(1, 12, 10)]);
    expect(r.diffs[0]!.diff).toBe(2);
    expect(r.valueSyp).toBe(2000);
  });

  it('values by absolute difference — a shortage and a surplus do not cancel out', () => {
    const r = countDifferences([line(1, 0, 10), line(2, 20, 10)]);
    expect(r.valueSyp).toBe(20000);
    expect(r.diffs).toHaveLength(2);
  });

  it('a count where everything matches is worth nothing and blocks nobody', () => {
    const r = countDifferences([line(1, 10, 10), line(2, 3, 3)]);
    expect(r.diffs).toEqual([]);
    expect(r.valueSyp).toBe(0);
  });
});
