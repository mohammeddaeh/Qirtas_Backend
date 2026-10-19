import { describe, expect, it } from 'vitest';
import {
  blocksMoney,
  byPerson,
  cashOutFits,
  cashOutNeedsApproval,
  depositedOf,
  differenceOf,
  expectedCash,
  hoursOpen,
  isStale,
  needsReason,
  needsReview,
  openingDifference,
} from '../services/shift-rules.js';

/**
 * The drawer is judged by these numbers, and each wrong one is silent: an
 * expected that counts its own over/short makes every drawer balance; a reason
 * asked at the threshold contradicts the setting's «above». Each with its opposite.
 */
describe('expected cash', () => {
  it('is the opening plus every cash movement of the shift', () => {
    const entries = [
      { type: 'sale_revenue', amountSyp: 12_000 },
      { type: 'refund', amountSyp: -1_350 },
      { type: 'cash_out', amountSyp: -5_000 },
      { type: 'cash_in', amountSyp: 2_000 },
      { type: 'debt_payment', amountSyp: 3_000 },
    ];
    expect(expectedCash(50_000, entries)).toBe(60_650);
  });

  it('leaves out the count\'s own over/short — or every drawer would balance', () => {
    const entries = [
      { type: 'sale_revenue', amountSyp: 10_000 },
      { type: 'cash_short', amountSyp: -500 },
      { type: 'cash_over', amountSyp: 200 },
    ];
    expect(expectedCash(0, entries)).toBe(10_000);
  });

  it('with nothing sold is the opening itself', () => {
    expect(expectedCash(25_000, [])).toBe(25_000);
  });
});

describe('the difference', () => {
  it('is positive over and negative short', () => {
    expect(differenceOf(60_000, 60_650)).toBe(-650);
    expect(differenceOf(61_000, 60_650)).toBe(350);
    expect(differenceOf(60_650, 60_650)).toBe(0);
  });

  it('asks for a reason above the threshold — not at it', () => {
    expect(needsReason(-10_001, 10_000)).toBe(true);
    expect(needsReason(10_001, 10_000)).toBe(true);
    expect(needsReason(-10_000, 10_000)).toBe(false);
    expect(needsReason(0, 0)).toBe(false);
    expect(needsReason(1, 0)).toBe(true);
  });

  it('never asks when the threshold is off', () => {
    expect(needsReason(-1_000_000, null)).toBe(false);
  });
});

describe('the opening', () => {
  it('differs from what the last close left', () => {
    expect(openingDifference(50_000, 45_000)).toBe(-5_000);
    expect(openingDifference(50_000, 50_000)).toBe(0);
  });

  it('has nothing to differ from when nothing was left on record', () => {
    expect(openingDifference(null, 45_000)).toBeNull();
  });

  it('sends to the safe what was not left in the drawer', () => {
    expect(depositedOf(80_000, 50_000)).toBe(30_000);
    expect(depositedOf(50_000, 50_000)).toBe(0);
  });
});

describe('a long shift', () => {
  const opened = new Date('2026-10-18T08:00:00Z');

  it('is flagged past the alert hours — and not before', () => {
    expect(isStale(opened, 16, new Date('2026-10-19T00:00:01Z'))).toBe(true);
    expect(isStale(opened, 16, new Date('2026-10-18T23:59:59Z'))).toBe(false);
  });

  it('counts whole hours open, never below zero', () => {
    expect(hoursOpen(opened, new Date('2026-10-18T20:30:00Z'))).toBe(12);
    expect(hoursOpen(opened, new Date('2026-10-18T07:00:00Z'))).toBe(0);
  });
});

describe('the branch drawer', () => {
  it('flags for review above the threshold — not at it, and never without one', () => {
    expect(needsReview(-50_001, 50_000)).toBe(true);
    expect(needsReview(50_001, 50_000)).toBe(true);
    expect(needsReview(-50_000, 50_000)).toBe(false);
    expect(needsReview(-1_000_000, null)).toBe(false);
  });

  it('asks a manager for a cash-out above the cap — not at it, and never without a cap', () => {
    expect(cashOutNeedsApproval(50_001, 50_000)).toBe(true);
    expect(cashOutNeedsApproval(50_000, 50_000)).toBe(false);
    expect(cashOutNeedsApproval(10_000_000, null)).toBe(false);
  });

  it('lets out what the drawer holds — and not a lira more', () => {
    expect(cashOutFits(23_350, 23_350)).toBe(true);
    expect(cashOutFits(23_350.01, 23_350)).toBe(false);
    expect(cashOutFits(1, 0)).toBe(false);
  });

  it('blocks money past the alert only when the setting says block', () => {
    const opened = new Date('2026-10-19T00:00:00Z');
    const later = new Date('2026-10-19T17:00:00Z');
    expect(blocksMoney(opened, 16, 'block', later)).toBe(true);
    expect(blocksMoney(opened, 16, 'warn', later)).toBe(false);
    expect(blocksMoney(opened, 16, 'block', new Date('2026-10-19T15:00:00Z'))).toBe(false);
  });

  it('says who did what, a line per person and device — the count itself is nobody\'s', () => {
    const lines = byPerson([
      { userId: 1, stationId: 7, type: 'sale_revenue', method: 'cash', amountSyp: 40_000 },
      { userId: 1, stationId: 7, type: 'sale_revenue', method: 'card', amountSyp: 5_000 },
      { userId: 2, stationId: null, type: 'sale_revenue', method: 'cash', amountSyp: 5_000 },
      { userId: 2, stationId: null, type: 'cash_out', method: 'cash', amountSyp: -3_000 },
      { userId: 2, stationId: 7, type: 'refund', method: 'cash', amountSyp: -1_000 },
      { userId: 3, stationId: 7, type: 'cash_short', method: 'cash', amountSyp: -500 },
      { userId: 3, stationId: 7, type: 'sale_cost', method: 'value', amountSyp: -9_000 },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ userId: 1, stationId: 7, salesSyp: 45_000, cashSalesSyp: 40_000 });
    const phone = lines.find((l) => l.userId === 2 && l.stationId === null)!;
    expect(phone).toMatchObject({ salesSyp: 5_000, cashOutSyp: 3_000, refundsSyp: 0 });
    const desk = lines.find((l) => l.userId === 2 && l.stationId === 7)!;
    expect(desk).toMatchObject({ refundsSyp: 1_000, salesSyp: 0 });
    expect(lines.some((l) => l.userId === 3)).toBe(false);
  });
});
