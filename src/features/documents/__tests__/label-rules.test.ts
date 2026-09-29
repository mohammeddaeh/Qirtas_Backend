import { describe, expect, it } from 'vitest';
import { pickLabelBarcode, pickLabelUnit } from '../services/label-rules.js';

/**
 * The wrong code on a shelf label does not fail: it scans as another item, or
 * as nothing, at the till. Each case beside its opposite.
 */

describe('pickLabelBarcode', () => {
  it("prefers the manufacturer's code, even when an internal one is older", () => {
    expect(
      pickLabelBarcode([
        { code: '2000000000015', source: 'internal' },
        { code: '6281000000001', source: 'manufacturer' },
      ]),
    ).toBe('6281000000001');
  });

  it('falls back to the internal code when there is no other', () => {
    expect(pickLabelBarcode([{ code: '2000000000015', source: 'internal' }])).toBe('2000000000015');
  });

  it('keeps the oldest of equals — a new code does not replace the one on the shelf', () => {
    expect(
      pickLabelBarcode([
        { code: 'A', source: 'manufacturer' },
        { code: 'B', source: 'manufacturer' },
      ]),
    ).toBe('A');
  });

  it('is null with no codes — never an invented one', () => {
    expect(pickLabelBarcode([])).toBeNull();
  });
});

describe('pickLabelUnit', () => {
  const units = [
    { unit_id: 1, is_base: true },
    { unit_id: 2, is_base: false },
  ];

  it('defaults to the base unit', () => {
    expect(pickLabelUnit(units, undefined)?.unit_id).toBe(1);
  });

  it('takes the unit asked for', () => {
    expect(pickLabelUnit(units, 2)?.unit_id).toBe(2);
  });

  it("refuses a unit that is not this variant's — no carton price on a piece", () => {
    expect(pickLabelUnit(units, 9)).toBeUndefined();
  });
});
