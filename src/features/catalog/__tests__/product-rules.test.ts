import { describe, expect, it } from 'vitest';
import {
  ambiguityOf,
  barcodeProblem,
  gtinCheckDigit,
  internalBarcode,
  isInternalBarcode,
  normalizeBarcode,
  sharedScopeOf,
} from '../services/barcode-rules.js';
import { combinationKey, variantSetProblem, type ValueRef } from '../services/variant-rules.js';

/**
 * Each failure here is quiet: a barcode with a wrong check digit saves and is
 * never scanned; an internal code that collides with a factory's sells the
 * wrong item; two variants with the same combination split one product's stock
 * across two rows. Every rule is pinned with its opposite.
 */

describe('barcodes', () => {
  it('computes the GS1 check digit', () => {
    expect(gtinCheckDigit('400638133393')).toBe(1); // 4006381333931 — a real EAN-13
    expect(gtinCheckDigit('9638507')).toBe(4); // 96385074 — EAN-8
  });

  it('accepts a correct EAN-13 and refuses the same code with one digit wrong', () => {
    expect(barcodeProblem('4006381333931')).toBeNull();
    expect(barcodeProblem('4006381333932')).toBe('checksum');
  });

  it('does not checksum codes of other shapes (internal/legacy labels)', () => {
    expect(barcodeProblem('QRT-000123')).toBeNull();
    expect(barcodeProblem('12345')).toBeNull();
  });

  it('refuses what a scanner cannot produce', () => {
    expect(barcodeProblem('abc')).toBe('format');
    expect(barcodeProblem('12 34')).toBe('format');
    expect(barcodeProblem('x'.repeat(40))).toBe('format');
  });

  it('normalizes what a person or a wedge scanner types', () => {
    expect(normalizeBarcode(' 4006381 333931\n')).toBe('4006381333931');
    expect(normalizeBarcode('qrt-1')).toBe('QRT-1');
  });

  it('builds internal codes in the in-store range with a valid check digit', () => {
    const code = internalBarcode(1);
    expect(code).toBe('2000000000015');
    expect(barcodeProblem(code)).toBeNull();
    expect(isInternalBarcode(code)).toBe(true);
    expect(internalBarcode(1)).not.toBe(internalBarcode(2));
  });

  it('never calls a manufacturer code internal', () => {
    expect(isInternalBarcode('4006381333931')).toBe(false);
    expect(isInternalBarcode('96385074')).toBe(false);
  });

  it('refuses a sequence that would overflow the 10 digits', () => {
    expect(() => internalBarcode(0)).toThrow();
    expect(() => internalBarcode(10_000_000_000)).toThrow();
  });

  it('tells a code one product wears twice from a code on two products', () => {
    // Proving the second case alone proves nothing: a function answering
    // 'cross_product' for everything passes it, and that one sends a person
    // to relabel every box/carton pair in the shop.
    expect(sharedScopeOf([7, 7, 7])).toBe('in_product');
    expect(sharedScopeOf([7, 9])).toBe('cross_product');
    // One match is not shared at all, and neither is none — the signal lists
    // codes with more than one row, and a single row must not read as a clash.
    expect(sharedScopeOf([7])).toBe('in_product');
    expect(sharedScopeOf([])).toBe('in_product');
  });

  it('tells a unit ambiguity from an item ambiguity', () => {
    expect(ambiguityOf([{ variantId: 1, unitId: 1 }])).toBe('none');
    expect(
      ambiguityOf([
        { variantId: 1, unitId: 1 },
        { variantId: 1, unitId: 2 },
      ]),
    ).toBe('unit');
    expect(
      ambiguityOf([
        { variantId: 1, unitId: 1 },
        { variantId: 2, unitId: 1 },
      ]),
    ).toBe('item');
  });
});

describe('variant sets', () => {
  // type 1 = colour (values 10 red, 11 blue), type 2 = size (20 A4, 21 A5), type 3 = theme (30), type 4 = material (40)
  const values = new Map<number, ValueRef>(
    [
      [10, 1],
      [11, 1],
      [20, 2],
      [21, 2],
      [30, 3],
      [40, 4],
    ].map(([id, typeId]) => [id!, { id: id!, typeId: typeId! }]),
  );
  const allowed = new Set([1, 2, 3, 4]);

  it('accepts a simple product (one variant, no attributes)', () => {
    expect(variantSetProblem([[]], values, allowed)).toBeNull();
  });

  it('accepts variants on the same axes', () => {
    expect(
      variantSetProblem(
        [
          [10, 20],
          [11, 20],
          [10, 21],
        ],
        values,
        allowed,
      ),
    ).toBeNull();
  });

  it('refuses variants that disagree on what distinguishes them', () => {
    expect(variantSetProblem([[10], [20]], values, allowed)).toEqual({ kind: 'axes_mismatch' });
  });

  it('refuses the same combination twice, in any order', () => {
    expect(
      variantSetProblem(
        [
          [10, 20],
          [20, 10],
        ],
        values,
        allowed,
      ),
    ).toEqual({ kind: 'duplicate_combination' });
  });

  it('refuses two values of one attribute on a variant', () => {
    expect(variantSetProblem([[10, 11]], values, allowed)).toEqual({
      kind: 'type_repeated',
      typeId: 1,
    });
  });

  it('refuses an attribute the category does not allow', () => {
    expect(variantSetProblem([[40]], values, new Set([1, 2]))).toEqual({
      kind: 'type_not_allowed',
      typeId: 4,
    });
  });

  it('refuses a fourth axis', () => {
    expect(variantSetProblem([[10, 20, 30, 40]], values, allowed)).toEqual({
      kind: 'too_many_axes',
    });
  });

  it('names an unknown value', () => {
    expect(variantSetProblem([[99]], values, allowed)).toEqual({
      kind: 'unknown_value',
      valueId: 99,
    });
  });

  it('keys combinations independent of order, and the simple product as empty', () => {
    expect(combinationKey([20, 10])).toBe(combinationKey([10, 20]));
    expect(combinationKey([])).toBe('');
  });
});
