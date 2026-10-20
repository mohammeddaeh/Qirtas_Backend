/**
 * What the shop owes a supplier, and how a payment settles it —
 * `docs/reference/finance_operations.md` §٣/§٣-ب. Pure, so every rule the
 * supplier's balance is judged by can be pinned by a test.
 *
 * A debt has two buckets: dollars (a dollar invoice not yet settled or fixed in
 * liras) and liras (a lira invoice, or a dollar one fixed in liras). A payment
 * lowers them **in the invoice's own currency**, and the dollars it settles are
 * valued twice — at the invoice's rate (what the goods cost) and at the
 * payment's (what settling cost); the difference is the realized gain or loss.
 */

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10_000) / 10_000;
/** Below a cent/hundredth of a cent, a remainder is rounding — not a debt. */
const EPS_SYP = 0.005;
const EPS_USD = 0.00005;

export interface InvoiceFacts {
  id: number;
  currency: 'SYP' | 'USD';
  invoiceDate: Date;
  /** The invoice's frozen rate — `null` for a lira invoice without one. */
  rate: number | null;
  totalSyp: number;
  totalUsd: number;
  /** Returned to the supplier from this invoice, valued at its cost in liras. */
  returnedSyp: number;
  /** Settled so far, per bucket. */
  paidUsd: number;
  paidSyp: number;
  /** Dollars fixed in liras, and the liras that replaced them. */
  convertedUsd: number;
  convertedSyp: number;
}

export type InvoicePayState = 'unpaid' | 'partial' | 'paid';

export interface InvoiceDue {
  dueUsd: number;
  dueSyp: number;
  state: InvoicePayState;
}

/**
 * What is still owed on one invoice. A dollar invoice's return is worth its
 * liras ÷ the invoice's rate — the goods went back at what they cost.
 */
export function invoiceDue(i: InvoiceFacts): InvoiceDue {
  let dueUsd = 0;
  let dueSyp = 0;
  if (i.currency === 'USD') {
    const returnedUsd = i.rate && i.rate > 0 ? i.returnedSyp / i.rate : 0;
    dueUsd = r4(Math.max(0, i.totalUsd - returnedUsd - i.paidUsd - i.convertedUsd));
    dueSyp = r2(Math.max(0, i.convertedSyp - i.paidSyp));
  } else {
    dueSyp = r2(Math.max(0, i.totalSyp - i.returnedSyp - i.paidSyp));
  }
  if (dueUsd < EPS_USD) dueUsd = 0;
  if (dueSyp < EPS_SYP) dueSyp = 0;
  // Fixing dollars in liras is an agreement, not a payment — an invoice
  // converted and never paid is still «unpaid», only in another currency.
  const anything = i.paidUsd + i.paidSyp > 0;
  const state: InvoicePayState = dueUsd === 0 && dueSyp === 0 ? 'paid' : anything ? 'partial' : 'unpaid';
  return { dueUsd, dueSyp, state };
}

export interface OpenInvoice {
  id: number;
  invoiceDate: Date;
  /** The invoice's rate — the dollars' cost. */
  rate: number | null;
  dueUsd: number;
  dueSyp: number;
}

export interface Allocation {
  invoiceId: number | null;
  bucket: 'USD' | 'SYP';
  amount: number;
  /** (invoice rate − payment rate) × dollars settled — signed, positive = gain. */
  gainSyp: number;
}

export interface PaymentSplit {
  allocations: Allocation[];
  /** Left over after every invoice is settled, in the payment's currency. */
  leftover: number;
}

/**
 * Spreads a payment over [invoices] in the order given (the caller passes them
 * oldest first, or in the order the payer chose). Each invoice: its dollars
 * first, then its liras.
 *
 * - Dollars paying dollars: one for one, the gain at the two rates.
 * - Liras paying dollars: at the payment's (agreed) rate.
 * - Dollars paying liras: the dollars changed at the payment's rate — no gain,
 *   the debt was liras.
 */
export function allocatePayment(
  invoices: OpenInvoice[],
  payment: { currency: 'SYP' | 'USD'; amount: number; rate: number },
): PaymentSplit {
  const out: Allocation[] = [];
  let left = payment.amount;
  const usd = payment.currency === 'USD';
  const eps = usd ? EPS_USD : EPS_SYP;
  for (const inv of invoices) {
    if (left <= eps) break;
    if (inv.dueUsd > 0) {
      // How many of the invoice's dollars this payment can settle.
      const canUsd = usd ? left : left / payment.rate;
      const settled = r4(Math.min(inv.dueUsd, canUsd));
      if (settled > 0) {
        const gain = inv.rate === null ? 0 : r2(settled * (inv.rate - payment.rate));
        out.push({ invoiceId: inv.id, bucket: 'USD', amount: settled, gainSyp: gain });
        left = usd ? r4(left - settled) : r2(left - settled * payment.rate);
      }
    }
    if (left <= eps) break;
    if (inv.dueSyp > 0) {
      const canSyp = usd ? left * payment.rate : left;
      const settled = r2(Math.min(inv.dueSyp, canSyp));
      if (settled > 0) {
        out.push({ invoiceId: inv.id, bucket: 'SYP', amount: settled, gainSyp: 0 });
        left = usd ? r4(left - settled / payment.rate) : r2(left - settled);
      }
    }
  }
  return { allocations: out, leftover: left <= eps ? 0 : left };
}

/**
 * Fixing a dollar debt in liras at an agreed rate: the liras that replace it,
 * and what the difference from the invoice's rate realizes.
 */
export function convertDebt(dueUsd: number, invoiceRate: number | null, agreedRate: number): { amountSyp: number; gainSyp: number } {
  const amountSyp = r2(dueUsd * agreedRate);
  const gainSyp = invoiceRate === null ? 0 : r2(dueUsd * (invoiceRate - agreedRate));
  return { amountSyp, gainSyp };
}

/**
 * What the open dollar debts would cost to settle today against what they were
 * booked at — **shown, never booked** (it moves with the rate). Positive = the
 * shop would gain. The sell rate is what buying the dollars would cost.
 */
export function unrealizedGain(open: { dueUsd: number; rate: number | null }[], sellRate: number): number {
  return r2(open.reduce((t, o) => (o.rate === null ? t : t + o.dueUsd * (o.rate - sellRate)), 0));
}

/** Days since the oldest invoice still owing — `null` when nothing is owed. */
export function oldestUnpaidDays(open: { invoiceDate: Date; dueUsd: number; dueSyp: number }[], now = new Date()): number | null {
  const owing = open.filter((o) => o.dueUsd > 0 || o.dueSyp > 0);
  if (owing.length === 0) return null;
  const oldest = Math.min(...owing.map((o) => o.invoiceDate.getTime()));
  return Math.max(0, Math.floor((now.getTime() - oldest) / 86_400_000));
}
