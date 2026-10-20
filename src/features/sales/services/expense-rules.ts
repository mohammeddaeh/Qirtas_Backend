/**
 * Expense and wage rules (`finance_operations.md` §٢) — pure, so the list, the
 * wages screen and the reminders answer from one place.
 */

export interface WageRow {
  amount: number;
  frequency: 'monthly' | 'weekly' | 'daily';
  dueDay: number;
  effectiveFrom: string; // YYYY-MM-DD
  endedOn: string | null;
}

/** `2026-10` — the month a date falls in. */
export function periodOf(day: string | Date): string {
  const s = typeof day === 'string' ? day : day.toISOString().slice(0, 10);
  return s.slice(0, 7);
}

/** Today as `YYYY-MM-DD`, in the server's day. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The wage on [day]: the latest row started on or before it — unless that row
 * was ended by then. A raise in March does not rewrite what January paid.
 */
export function wageOn<T extends WageRow>(rows: T[], day: string): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.effectiveFrom > day) continue;
    if (best === null || r.effectiveFrom >= best.effectiveFrom) best = r;
  }
  if (best === null) return null;
  if (best.endedOn !== null && best.endedOn <= day) return null;
  return best;
}

/**
 * What is left of a monthly wage this month: the wage, less what was paid and
 * advanced in the month. `null` for a weekly or daily wage — those are paid as
 * worked, and «left» would invent the days.
 */
export function wageLeft(wage: WageRow | null, paidInPeriod: number): number | null {
  if (wage === null || wage.frequency !== 'monthly') return null;
  return Math.max(0, wage.amount - paidInPeriod);
}

/**
 * A monthly bill is due this month once its day has come and it was not yet
 * recorded for the month — a reminder, never written by itself.
 */
export function recurringDue(dayOfMonth: number, recordedThisPeriod: boolean, today: string): boolean {
  if (recordedThisPeriod) return false;
  return Number(today.slice(8, 10)) >= dayOfMonth;
}

/** A wage falls due this month once its day has come and less than all of it was paid. */
export function wageDue(wage: WageRow | null, paidInPeriod: number, today: string): boolean {
  if (wage === null || wage.frequency !== 'monthly') return false;
  return Number(today.slice(8, 10)) >= wage.dueDay && paidInPeriod + 1e-9 < wage.amount;
}
