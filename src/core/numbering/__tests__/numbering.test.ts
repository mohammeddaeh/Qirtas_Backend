import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, datePart, formatProblem, render, stemOf } from '../numbering.js';

const at = new Date(2026, 9, 5);

describe('numbering', () => {
  it('the defaults reproduce the shapes numbers had before', () => {
    expect(render(DEFAULT_FORMATS.sale, 'BR1', at, 36)).toBe('BR1-2026-000036');
    expect(render(DEFAULT_FORMATS.sale_return, 'BR1', at, 10)).toBe('BR1-R-2026-000010');
    expect(render(DEFAULT_FORMATS.print_job, 'MZ', at, 3)).toBe('MZ-P-2026-000003');
    expect(render(DEFAULT_FORMATS.ready_copy, 'MZ', at, 4)).toBe('MZ-J-0004');
  });

  it('every date format — and none', () => {
    expect(datePart('none', at)).toBe('');
    expect(datePart('yy', at)).toBe('26');
    expect(datePart('yymm', at)).toBe('2610');
    expect(datePart('yymmdd', at)).toBe('261005');
    expect(datePart('mmdd', at)).toBe('1005');
  });

  it('the stem changes exactly when the shown date changes', () => {
    const daily = { prefix: 'R', date_format: 'yymmdd' as const, digits: 3 };
    expect(stemOf(daily, 'MZ', at)).not.toBe(stemOf(daily, 'MZ', new Date(2026, 9, 6)));
    const yearly = { prefix: 'R', date_format: 'yyyy' as const, digits: 6 };
    expect(stemOf(yearly, 'MZ', at)).toBe(stemOf(yearly, 'MZ', new Date(2026, 11, 31)));
  });

  it('refuses a shared prefix, a bad prefix, bad digits and too long — and accepts a sound one', () => {
    const others = { ...DEFAULT_FORMATS };
    expect(formatProblem('order', { prefix: 'R', date_format: 'yyyy', digits: 6 }, others)).toBe('numbering_prefix_taken');
    expect(formatProblem('order', { prefix: 'r1', date_format: 'yyyy', digits: 6 }, others)).toBe('numbering_prefix_invalid');
    expect(formatProblem('order', { prefix: 'O', date_format: 'yyyy', digits: 2 }, others)).toBe('numbering_digits_invalid');
    expect(formatProblem('order', { prefix: 'ORDR', date_format: 'yymmdd', digits: 8 }, others)).toBe('numbering_too_long');
    expect(formatProblem('order', { prefix: 'O', date_format: 'yymm', digits: 4 }, others)).toBeNull();
  });
  it('the pickup code is short and dated — and shares no prefix rule with documents', () => {
    // The counter keeps the branch (it is in the stem); the number shown drops it.
    expect(stemOf(DEFAULT_FORMATS.pickup, 'BR1', at)).toBe('BR1-1005-');
    expect(render(DEFAULT_FORMATS.pickup, 'BR1', at, 42)).toBe('BR1-1005-042');
    // Tomorrow is another stem — yesterday's 042 is never today's.
    expect(stemOf(DEFAULT_FORMATS.pickup, 'BR1', new Date(2026, 9, 6))).not.toBe(stemOf(DEFAULT_FORMATS.pickup, 'BR1', at));
    // No prefix, like the invoice — and neither refuses the other.
    const others = { ...DEFAULT_FORMATS };
    expect(formatProblem('pickup', DEFAULT_FORMATS.pickup, others)).toBeNull();
    expect(formatProblem('sale', DEFAULT_FORMATS.sale, others)).toBeNull();
    // Documents still refuse each other's prefix.
    expect(formatProblem('order', { prefix: 'R', date_format: 'yyyy', digits: 6 }, others)).toBe('numbering_prefix_taken');
  });
});
