import { describe, expect, it } from 'vitest';

import { tillActionFor } from '../services/job-rules.js';

const job = (over: Partial<Parameters<typeof tillActionFor>[0]>) => ({
  status: 'awaiting_payment' as const,
  payment_status: 'unpaid' as const,
  sale_id: null,
  quoted_total_syp: '60000.00',
  ...over,
});

/**
 * What the till may do with an order it found (9-ح-2 audit). A wrong answer
 * is silent: an order to pay for shown as nothing to do is the customer told
 * «it does not exist» — which is exactly the report that found this.
 */
describe('tillActionFor', () => {
  it('priced, unpaid: pay before printing — a line on this invoice', () => {
    expect(tillActionFor(job({}), 5)).toBe('add');
  });

  it('on this invoice already ≠ on another open one', () => {
    expect(tillActionFor(job({ sale_id: 5 }), 5)).toBe('in_this_sale');
    expect(tillActionFor(job({ sale_id: 27 }), 5)).toBe('in_other_sale');
    // No invoice open at the till yet: any basket holding it is another one.
    expect(tillActionFor(job({ sale_id: 27 }), null)).toBe('in_other_sale');
    // The invoice that paid it stays on the row — that is history, not a basket.
    expect(tillActionFor(job({ status: 'picked_up', payment_status: 'paid', sale_id: 31 }), 5)).toBe('closed');
    expect(tillActionFor(job({ status: 'ready', payment_status: 'paid', sale_id: 31 }), 5)).toBe('hand_over');
  });

  it('ready and paid is handed over; ready unpaid or deferred is collected first', () => {
    expect(tillActionFor(job({ status: 'ready', payment_status: 'paid' }), 5)).toBe('hand_over');
    expect(tillActionFor(job({ status: 'ready', payment_status: 'deferred' }), 5)).toBe('add');
  });

  it('a debt is collected at any stage — even after pickup', () => {
    expect(tillActionFor(job({ status: 'in_production', payment_status: 'deferred' }), 5)).toBe('add');
    expect(tillActionFor(job({ status: 'picked_up', payment_status: 'deferred' }), 5)).toBe('add');
  });

  it('nothing to collect: unpriced, paid and printing, closed', () => {
    expect(tillActionFor(job({ status: 'awaiting_quote', quoted_total_syp: null }), 5)).toBe('not_priced');
    expect(tillActionFor(job({ status: 'queued', payment_status: 'paid' }), 5)).toBe('paid_in_work');
    expect(tillActionFor(job({ status: 'picked_up', payment_status: 'paid' }), 5)).toBe('closed');
    expect(tillActionFor(job({ status: 'expired' }), 5)).toBe('closed');
  });

  it('owed but with no price is not offered as a line', () => {
    expect(tillActionFor(job({ quoted_total_syp: null }), 5)).not.toBe('add');
  });
});
