import { describe, expect, it } from 'vitest';
import { creditOverdue, daysSince, oldestUnpaidAt, splitPayment } from '../services/debt-rules.js';

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 10));

describe('oldestUnpaidAt — first in, first out', () => {
  it('nothing owed is null — not the first sale', () => {
    expect(oldestUnpaidAt([])).toBeNull();
    expect(oldestUnpaidAt([{ amount: -500, at: day(1) }, { amount: 500, at: day(3) }])).toBeNull();
  });

  it('a payment settles the oldest charge — the age moves to the next one', () => {
    const moves = [
      { amount: -1000, at: day(1) },
      { amount: -2000, at: day(5) },
      { amount: 1000, at: day(6) },
    ];
    expect(oldestUnpaidAt(moves)).toEqual(day(5));
  });

  it('a part payment leaves the oldest charge still owed', () => {
    const moves = [
      { amount: -1000, at: day(1) },
      { amount: -2000, at: day(5) },
      { amount: 600, at: day(6) },
    ];
    expect(oldestUnpaidAt(moves)).toEqual(day(1));
  });

  it('credit held before a charge is spent on it', () => {
    const moves = [
      { amount: 1500, at: day(1) },
      { amount: -1000, at: day(2) },
      { amount: -1000, at: day(4) },
    ];
    expect(oldestUnpaidAt(moves)).toEqual(day(4));
  });

  it('an overpayment carries forward as credit', () => {
    const moves = [
      { amount: -1000, at: day(1) },
      { amount: 1500, at: day(2) },
      { amount: -400, at: day(3) },
    ];
    expect(oldestUnpaidAt(moves)).toBeNull();
  });
});

describe('creditOverdue', () => {
  it('no limit never stops — nor does nothing owed', () => {
    expect(creditOverdue(day(1), null, day(30))).toBe(false);
    expect(creditOverdue(null, 7, day(30))).toBe(false);
  });

  it('stops past the limit — and not on its last day', () => {
    expect(creditOverdue(day(1), 7, day(9))).toBe(true);
    expect(creditOverdue(day(1), 7, day(8))).toBe(false);
  });

  it('daysSince is whole days, never negative', () => {
    expect(daysSince(day(1), day(1))).toBe(0);
    expect(daysSince(day(1), day(4))).toBe(3);
    expect(daysSince(day(4), day(1))).toBe(0);
  });
});

describe('splitPayment', () => {
  it('within the debt settles it all — nothing extra', () => {
    expect(splitPayment(500, -2000)).toEqual({ settles: 500, extra: 0 });
  });

  it('above the debt names the extra', () => {
    expect(splitPayment(2500, -2000)).toEqual({ settles: 2000, extra: 500 });
  });

  it('nothing owed makes it all extra', () => {
    expect(splitPayment(300, 0)).toEqual({ settles: 0, extra: 300 });
    expect(splitPayment(300, 1000)).toEqual({ settles: 0, extra: 300 });
  });
});
