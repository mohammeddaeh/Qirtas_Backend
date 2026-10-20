import { describe, expect, it } from 'vitest';
import { allocatePayment, convertDebt, invoiceDue, oldestUnpaidDays, unrealizedGain, type InvoiceFacts } from '../payables-rules.js';

const usdInvoice = (over: Partial<InvoiceFacts> = {}): InvoiceFacts => ({
  id: 1,
  currency: 'USD',
  invoiceDate: new Date('2026-10-01'),
  rate: 13_000,
  totalSyp: 5_200_000,
  totalUsd: 400,
  returnedSyp: 0,
  paidUsd: 0,
  paidSyp: 0,
  convertedUsd: 0,
  convertedSyp: 0,
  ...over,
});

describe('what is owed on an invoice — in its own currency', () => {
  it('a dollar invoice is a dollar debt — no liras owed until it is fixed in liras', () => {
    expect(invoiceDue(usdInvoice())).toEqual({ dueUsd: 400, dueSyp: 0, state: 'unpaid' });
  });

  it('a return lowers it at the invoice rate — not today’s', () => {
    // 1,300,000 returned at 13,000 = $100.
    expect(invoiceDue(usdInvoice({ returnedSyp: 1_300_000 })).dueUsd).toBe(300);
  });

  it('partly paid is partial — fully paid is paid, a cent of rounding is not a debt', () => {
    expect(invoiceDue(usdInvoice({ paidUsd: 100 })).state).toBe('partial');
    expect(invoiceDue(usdInvoice({ paidUsd: 399.99999 })).state).toBe('paid');
  });

  it('fixed in liras: the dollars leave, the liras are owed', () => {
    const d = invoiceDue(usdInvoice({ convertedUsd: 400, convertedSyp: 5_280_000 }));
    expect(d.dueUsd).toBe(0);
    expect(d.dueSyp).toBe(5_280_000);
    // Fixed, not paid — «partly paid» over an invoice nobody paid a lira of.
    expect(d.state).toBe('unpaid');
    // And once liras are paid on it, it is partly paid.
    expect(invoiceDue(usdInvoice({ convertedUsd: 400, convertedSyp: 5_280_000, paidSyp: 1_000_000 })).state).toBe('partial');
  });

  it('a lira invoice owes liras, its returns at their liras', () => {
    const d = invoiceDue({ ...usdInvoice(), currency: 'SYP', rate: null, totalSyp: 900_000, returnedSyp: 100_000 });
    expect(d).toEqual({ dueUsd: 0, dueSyp: 800_000, state: 'unpaid' });
  });
});

describe('a payment — oldest first, in each invoice’s currency', () => {
  const open = [
    { id: 1, invoiceDate: new Date('2026-09-01'), rate: 13_000, dueUsd: 400, dueSyp: 0 },
    { id: 2, invoiceDate: new Date('2026-10-01'), rate: null, dueUsd: 0, dueSyp: 1_000_000 },
  ];

  it('$400 at a cheaper dollar settles the dollar invoice and realizes the gain', () => {
    const s = allocatePayment(open, { currency: 'USD', amount: 400, rate: 12_500 });
    expect(s.allocations).toEqual([{ invoiceId: 1, bucket: 'USD', amount: 400, gainSyp: 200_000 }]);
    expect(s.leftover).toBe(0);
  });

  it('a dearer dollar is a loss — signed, not hidden', () => {
    const s = allocatePayment(open, { currency: 'USD', amount: 100, rate: 13_400 });
    expect(s.allocations[0]!.gainSyp).toBe(-40_000);
  });

  it('liras pay the dollar debt at the agreed rate, then the lira invoice', () => {
    const s = allocatePayment(open, { currency: 'SYP', amount: 5_800_000, rate: 13_000 });
    expect(s.allocations).toEqual([
      { invoiceId: 1, bucket: 'USD', amount: 400, gainSyp: 0 },
      { invoiceId: 2, bucket: 'SYP', amount: 600_000, gainSyp: 0 },
    ]);
    expect(s.leftover).toBe(0);
  });

  it('more than is owed leaves the rest — in the payment’s currency', () => {
    const s = allocatePayment(open, { currency: 'SYP', amount: 7_000_000, rate: 13_000 });
    expect(s.leftover).toBe(800_000);
  });

  it('dollars paying a lira invoice change at the payment rate — and realize nothing', () => {
    const s = allocatePayment([open[1]!], { currency: 'USD', amount: 50, rate: 13_000 });
    expect(s.allocations).toEqual([{ invoiceId: 2, bucket: 'SYP', amount: 650_000, gainSyp: 0 }]);
  });

  it('nothing open — the whole payment is left over', () => {
    expect(allocatePayment([], { currency: 'USD', amount: 10, rate: 1 }).leftover).toBe(10);
  });
});

describe('fixing a dollar debt in liras', () => {
  it('the liras at the agreed rate — and the difference from the invoice realized', () => {
    expect(convertDebt(400, 13_000, 13_200)).toEqual({ amountSyp: 5_280_000, gainSyp: -80_000 });
    expect(convertDebt(400, 13_000, 12_800)).toEqual({ amountSyp: 5_120_000, gainSyp: 80_000 });
  });
});

describe('the open dollars at today’s rate — shown, never booked', () => {
  it('a dearer dollar today is an estimated loss — a lira debt has none', () => {
    expect(unrealizedGain([{ dueUsd: 400, rate: 13_000 }, { dueUsd: 0, rate: null }], 13_300)).toBe(-120_000);
  });
});

describe('the oldest unpaid', () => {
  it('counts from the oldest invoice still owing — a settled one does not count', () => {
    const now = new Date('2026-10-20');
    expect(
      oldestUnpaidDays(
        [
          { invoiceDate: new Date('2026-09-01'), dueUsd: 0, dueSyp: 0 },
          { invoiceDate: new Date('2026-10-10'), dueUsd: 5, dueSyp: 0 },
        ],
        now,
      ),
    ).toBe(10);
    expect(oldestUnpaidDays([], now)).toBeNull();
  });
});
