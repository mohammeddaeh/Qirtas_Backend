import { describe, expect, it } from 'vitest';
import { periodOf, recurringDue, wageDue, wageLeft, wageOn, type WageRow } from '../services/expense-rules.js';

const w = (effectiveFrom: string, amount: number, extra: Partial<WageRow> = {}): WageRow => ({
  amount,
  frequency: 'monthly',
  dueDay: 1,
  effectiveFrom,
  endedOn: null,
  ...extra,
});

describe('wageOn — a row per change, from its day', () => {
  it('the latest row started on or before the day', () => {
    const rows = [w('2026-01-01', 1_000_000), w('2026-03-01', 1_200_000)];
    expect(wageOn(rows, '2026-02-15')?.amount).toBe(1_000_000);
    expect(wageOn(rows, '2026-03-01')?.amount).toBe(1_200_000);
  });

  it('nothing before the first row — and nothing after an end', () => {
    expect(wageOn([w('2026-05-01', 1)], '2026-04-30')).toBeNull();
    expect(wageOn([w('2026-01-01', 1, { endedOn: '2026-06-01' })], '2026-06-01')).toBeNull();
    expect(wageOn([w('2026-01-01', 1, { endedOn: '2026-06-01' })], '2026-05-31')?.amount).toBe(1);
  });
});

describe('wageLeft and wageDue', () => {
  it('a monthly wage less what was paid and advanced — never below zero', () => {
    expect(wageLeft(w('2026-01-01', 1_000_000), 300_000)).toBe(700_000);
    expect(wageLeft(w('2026-01-01', 1_000_000), 1_200_000)).toBe(0);
  });

  it('weekly and daily wages say no «left» — and are never «due»', () => {
    const weekly = w('2026-01-01', 200_000, { frequency: 'weekly' });
    expect(wageLeft(weekly, 0)).toBeNull();
    expect(wageDue(weekly, 0, '2026-10-20')).toBe(false);
  });

  it('due once its day came and not all of it paid', () => {
    const wage = w('2026-01-01', 1_000_000, { dueDay: 25 });
    expect(wageDue(wage, 0, '2026-10-24')).toBe(false);
    expect(wageDue(wage, 0, '2026-10-25')).toBe(true);
    expect(wageDue(wage, 1_000_000, '2026-10-26')).toBe(false);
  });
});

describe('recurringDue — a reminder', () => {
  it('due from its day — not before, and not once recorded', () => {
    expect(recurringDue(5, false, '2026-10-04')).toBe(false);
    expect(recurringDue(5, false, '2026-10-05')).toBe(true);
    expect(recurringDue(5, true, '2026-10-20')).toBe(false);
  });

  it('periodOf is the month', () => {
    expect(periodOf('2026-10-19')).toBe('2026-10');
  });
});
