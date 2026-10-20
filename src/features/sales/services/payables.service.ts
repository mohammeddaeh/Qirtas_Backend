import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { recordFinance } from '../../../core/finance/finance-recorder.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import { SALES_AUDIT, saleTarget } from '../audit-actions.js';
import * as repo from '../repositories/payables.repository.js';
import { findSettings } from '../repositories/returns.repository.js';
import * as salesRepo from '../repositories/sales.repository.js';
import type { SupplierPaymentRow } from '../schemas/payables.schema.js';
import { currentRate } from './fx.service.js';
import {
  allocatePayment,
  convertDebt,
  invoiceDue,
  oldestUnpaidDays,
  unrealizedGain,
  type InvoicePayState,
  type OpenInvoice,
} from './payables-rules.js';
import { drawerCashBack, drawerCashOut } from './shifts.service.js';

/**
 * What the shop owes its suppliers (`docs/reference/finance_operations.md` §٣/§٣-ب):
 * each invoice's debt in its own currency, payments from the drawer or outside
 * it spread over invoices (the oldest first), a dollar debt fixed in liras, and
 * the realized exchange difference booked with each — the open one only shown.
 *
 * **A payment to a supplier is not an expense**: the goods entered stock at
 * their cost, which shows when they sell. It lowers the cash, nothing else.
 */

export const PAY_KEY = 'suppliers.pay';

const r2 = (v: number): number => Math.round(v * 100) / 100;
const num = (v: string | null): number => (v === null ? 0 : Number(v));

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface WirePayableInvoice {
  id: number;
  number: string;
  supplier_invoice_no: string | null;
  branch_id: number;
  branch_name: string | null;
  invoice_date: string;
  currency: 'SYP' | 'USD';
  rate: number | null;
  total_usd: number;
  total_syp: number;
  returned_syp: number;
  paid_usd: number;
  paid_syp: number;
  converted_usd: number;
  converted_syp: number;
  due_usd: number;
  due_syp: number;
  state: InvoicePayState;
  /** Realized so far on this invoice — signed, positive = the shop gained. */
  fx_realized_syp: number;
  /** The open dollars at today's sell rate — what settling them would cost. `null` without dollars or a rate. */
  due_usd_today_syp: number | null;
}

interface InvoiceState {
  invoice: repo.InvoiceRow;
  wire: WirePayableInvoice;
}

/** Every invoice of [filter] with what is still owed — in one pass over the four tables. */
async function invoiceStates(exec: Tx | typeof db, filter: { supplierId?: number; branchId?: number; invoiceId?: number }): Promise<InvoiceState[]> {
  const invoices = await repo.findInvoices(filter);
  const ids = invoices.map((i) => i.id);
  const [returned, allocated, converted, branches, fx] = await Promise.all([
    repo.findReturnedByInvoice(ids),
    repo.findAllocatedByInvoice(exec, ids),
    repo.findConvertedByInvoice(exec, ids),
    salesRepo.findBranchNames([...new Set(invoices.map((i) => i.branchId))]),
    currentRate(),
  ]);
  const sell = fx === null ? null : Number(fx.sell_rate);
  return invoices.map((inv) => {
    const a = allocated.get(inv.id) ?? { paidUsd: 0, paidSyp: 0, gainSyp: 0 };
    const c = converted.get(inv.id) ?? { usd: 0, syp: 0, gainSyp: 0 };
    const ret = returned.get(inv.id) ?? 0;
    const due = invoiceDue({
      id: inv.id,
      currency: inv.currency,
      invoiceDate: inv.invoiceDate,
      rate: inv.rate,
      totalSyp: inv.totalSyp,
      totalUsd: inv.totalUsd,
      returnedSyp: ret,
      paidUsd: a.paidUsd,
      paidSyp: a.paidSyp,
      convertedUsd: c.usd,
      convertedSyp: c.syp,
    });
    return {
      invoice: inv,
      wire: {
        id: inv.id,
        number: inv.number,
        supplier_invoice_no: inv.supplierInvoiceNo,
        branch_id: inv.branchId,
        branch_name: branches.get(inv.branchId) ?? null,
        invoice_date: inv.invoiceDate.toISOString(),
        currency: inv.currency,
        rate: inv.rate,
        total_usd: inv.totalUsd,
        total_syp: inv.totalSyp,
        returned_syp: ret,
        paid_usd: r2(a.paidUsd),
        paid_syp: r2(a.paidSyp),
        converted_usd: c.usd,
        converted_syp: c.syp,
        due_usd: due.dueUsd,
        due_syp: due.dueSyp,
        state: due.state,
        fx_realized_syp: r2(a.gainSyp + c.gainSyp),
        due_usd_today_syp: due.dueUsd > 0 && sell !== null ? r2(due.dueUsd * sell) : null,
      },
    };
  });
}

// ── The list: who we owe ────────────────────────────────────────────────────

export interface WirePayableRow {
  supplier_id: number;
  name: string;
  phone: string | null;
  due_usd: number;
  due_syp: number;
  /** Our money left with the supplier (an overpayment the shop allows). */
  credit_usd: number;
  credit_syp: number;
  open_invoices: number;
  oldest_unpaid_at: string | null;
  oldest_unpaid_days: number | null;
  last_payment_at: string | null;
}

export interface WirePayables {
  items: WirePayableRow[];
  summary: {
    suppliers: number;
    due_usd: number;
    due_syp: number;
    /** The open dollars at today's sell rate against their invoices' — shown, never booked. `null` without a rate. */
    unrealized_syp: number | null;
  };
}

/** Who the shop owes — the oldest unpaid first (who has waited longest). */
export async function listPayables(filter: { search?: string; branchId?: number }): Promise<WirePayables> {
  const states = await invoiceStates(db, { branchId: filter.branchId });
  const bySupplier = new Map<number, InvoiceState[]>();
  for (const s of states) {
    const list = bySupplier.get(s.invoice.supplierId) ?? [];
    list.push(s);
    bySupplier.set(s.invoice.supplierId, list);
  }
  const supplierIds = [...bySupplier.keys()];
  const [suppliers, credit, lastPaid, fx] = await Promise.all([
    repo.findSuppliers(supplierIds, filter.search ? normalizeArabic(filter.search) : undefined),
    repo.findCredit(supplierIds),
    repo.findLastPaymentAt(supplierIds),
    currentRate(),
  ]);
  const items: WirePayableRow[] = [];
  const open: { dueUsd: number; rate: number | null }[] = [];
  for (const sup of suppliers) {
    const list = bySupplier.get(sup.id) ?? [];
    const owing = list.filter((s) => s.wire.due_usd > 0 || s.wire.due_syp > 0);
    const c = credit.get(sup.id) ?? { usd: 0, syp: 0 };
    if (owing.length === 0 && c.usd === 0 && c.syp === 0) continue;
    for (const s of owing) open.push({ dueUsd: s.wire.due_usd, rate: s.invoice.rate });
    const oldest = owing.length === 0 ? null : owing.reduce((m, s) => (s.invoice.invoiceDate < m ? s.invoice.invoiceDate : m), owing[0]!.invoice.invoiceDate);
    items.push({
      supplier_id: sup.id,
      name: sup.name,
      phone: sup.phone,
      due_usd: r2(owing.reduce((t, s) => t + s.wire.due_usd, 0)),
      due_syp: r2(owing.reduce((t, s) => t + s.wire.due_syp, 0)),
      credit_usd: r2(c.usd),
      credit_syp: r2(c.syp),
      open_invoices: owing.length,
      oldest_unpaid_at: oldest?.toISOString() ?? null,
      oldest_unpaid_days: oldestUnpaidDays(owing.map((s) => ({ invoiceDate: s.invoice.invoiceDate, dueUsd: s.wire.due_usd, dueSyp: s.wire.due_syp }))),
      last_payment_at: lastPaid.get(sup.id)?.toISOString() ?? null,
    });
  }
  // Oldest debt first — the supplier who has waited longest; then the largest.
  items.sort((a, b) => (b.oldest_unpaid_days ?? -1) - (a.oldest_unpaid_days ?? -1) || b.due_syp - a.due_syp);
  return {
    items,
    summary: {
      suppliers: items.length,
      due_usd: r2(items.reduce((t, i) => t + i.due_usd, 0)),
      due_syp: r2(items.reduce((t, i) => t + i.due_syp, 0)),
      unrealized_syp: fx === null ? null : unrealizedGain(open, Number(fx.sell_rate)),
    },
  };
}

// ── One supplier ────────────────────────────────────────────────────────────

export interface WirePayment {
  id: number;
  branch_id: number;
  branch_name: string | null;
  currency: 'SYP' | 'USD';
  amount: number;
  fx_rate: number;
  source: 'drawer' | 'outside';
  note: string | null;
  created_by_name: string | null;
  created_at: string;
  /** This row undoes another payment. */
  reverses_payment_id: number | null;
  /** Another row undid this one. */
  reversed: boolean;
  fx_gain_syp: number;
  allocations: { invoice_id: number | null; invoice_number: string | null; bucket: 'SYP' | 'USD'; amount: number }[];
}

export interface WireSupplierAccount {
  supplier: { id: number; name: string; phone: string | null };
  due_usd: number;
  due_syp: number;
  credit_usd: number;
  credit_syp: number;
  unrealized_syp: number | null;
  fx: { buy_rate: number; sell_rate: number } | null;
  /** Whether the shop keeps an overpayment as our credit with the supplier. */
  overpay_to_credit: boolean;
  invoices: WirePayableInvoice[];
  payments: WirePayment[];
  conversions: { id: number; invoice_id: number; amount_usd: number; rate: number; amount_syp: number; fx_gain_syp: number; note: string | null; created_at: string }[];
}

export async function getSupplierAccount(supplierId: number, branchId?: number): Promise<WireSupplierAccount> {
  const supplier = await repo.findSupplier(supplierId);
  if (!supplier || supplier.system_key !== null) throw new NotFoundError('Supplier not found');
  const [states, payments, credit, fx, settings] = await Promise.all([
    invoiceStates(db, { supplierId, branchId }),
    repo.findPayments(supplierId, branchId),
    repo.findCredit([supplierId]),
    currentRate(),
    findSettings(),
  ]);
  const allocations = await repo.findAllocationsOf(db, payments.map((p) => p.id));
  const numbers = new Map(states.map((s) => [s.invoice.id, s.invoice.number]));
  const [users, branches, conversions] = await Promise.all([
    salesRepo.findUserNames([...new Set(payments.flatMap((p) => (p.created_by_user_id === null ? [] : [p.created_by_user_id])))]),
    salesRepo.findBranchNames([...new Set(payments.map((p) => p.branch_id))]),
    repo.findConversions(states.map((s) => s.invoice.id)),
  ]);
  const reversed = new Set(payments.flatMap((p) => (p.reverses_payment_id === null ? [] : [p.reverses_payment_id])));
  const owing = states.filter((s) => s.wire.due_usd > 0 || s.wire.due_syp > 0);
  const c = credit.get(supplierId) ?? { usd: 0, syp: 0 };
  return {
    supplier: { id: supplier.id, name: supplier.name, phone: supplier.phone },
    due_usd: r2(owing.reduce((t, s) => t + s.wire.due_usd, 0)),
    due_syp: r2(owing.reduce((t, s) => t + s.wire.due_syp, 0)),
    credit_usd: r2(c.usd),
    credit_syp: r2(c.syp),
    unrealized_syp:
      fx === null ? null : unrealizedGain(owing.map((s) => ({ dueUsd: s.wire.due_usd, rate: s.invoice.rate })), Number(fx.sell_rate)),
    fx: fx === null ? null : { buy_rate: Number(fx.buy_rate), sell_rate: Number(fx.sell_rate) },
    overpay_to_credit: settings.overpay_to_credit_suppliers,
    // Newest first on the screen — the open ones lead.
    invoices: states
      .map((s) => s.wire)
      .sort((a, b) => (a.state === 'paid' ? 1 : 0) - (b.state === 'paid' ? 1 : 0) || b.invoice_date.localeCompare(a.invoice_date)),
    payments: payments.map((p) => {
      const mine = allocations.filter((a) => a.payment_id === p.id);
      return {
        id: p.id,
        branch_id: p.branch_id,
        branch_name: branches.get(p.branch_id) ?? null,
        currency: p.currency === 'USD' ? 'USD' : 'SYP',
        amount: Number(p.amount),
        fx_rate: Number(p.fx_rate),
        source: p.source === 'drawer' ? 'drawer' : 'outside',
        note: p.note,
        created_by_name: p.created_by_user_id === null ? null : (users.get(p.created_by_user_id) ?? null),
        created_at: p.created_at.toISOString(),
        reverses_payment_id: p.reverses_payment_id,
        reversed: reversed.has(p.id),
        fx_gain_syp: r2(mine.reduce((t, a) => t + Number(a.fx_gain_syp), 0)),
        allocations: mine.map((a) => ({
          invoice_id: a.invoice_id,
          invoice_number: a.invoice_id === null ? null : (numbers.get(a.invoice_id) ?? null),
          bucket: a.bucket === 'USD' ? 'USD' : 'SYP',
          amount: Number(a.amount),
        })),
      };
    }),
    conversions: conversions.map((x) => ({
      id: x.id,
      invoice_id: x.invoice_id,
      amount_usd: Number(x.amount_usd),
      rate: Number(x.rate),
      amount_syp: Number(x.amount_syp),
      fx_gain_syp: Number(x.fx_gain_syp),
      note: x.note,
      created_at: x.created_at.toISOString(),
    })),
  };
}

/** One invoice's payment state — the purchase invoice screen shows it. */
export async function getInvoicePayState(invoiceId: number): Promise<WirePayableInvoice> {
  const [state] = await invoiceStates(db, { invoiceId });
  if (!state) throw new NotFoundError('Invoice not found');
  return state.wire;
}

// ── Paying ──────────────────────────────────────────────────────────────────

async function requirePayAt(actor: RequestActorContext, branchId: number): Promise<void> {
  if (!(await holdsPermissionAt(actor.userId, PAY_KEY, branchId))) {
    throw new BusinessError(403, 'Not at this branch', 'payable_not_at_branch');
  }
}

export interface PayInput {
  supplier_id: number;
  branch_id: number;
  currency: 'SYP' | 'USD';
  amount: number;
  /** Liras paying a dollar debt: the rate agreed with the supplier (default: today's sell rate). */
  fx_rate?: number;
  source: 'drawer' | 'outside';
  /** The invoices to settle, in order — absent: the oldest first. */
  invoice_ids?: number[];
  note?: string;
}

/**
 * A payment to a supplier — from the branch's drawer (its shift, the cap and
 * approval of a cash-out) or from outside. Spread over the branch's open
 * invoices of that supplier, the oldest first unless chosen; each dollar settled
 * realizes (invoice rate − payment rate). More than is owed: our credit with the
 * supplier when the shop allows it, else refused before anything moves.
 */
export async function pay(actor: RequestActorContext, input: PayInput, approverUserId: number | null): Promise<WireSupplierAccount> {
  await requirePayAt(actor, input.branch_id);
  const supplier = await repo.findSupplier(input.supplier_id);
  if (!supplier || supplier.system_key !== null) throw new NotFoundError('Supplier not found');
  const fx = await currentRate();
  const states = await invoiceStates(db, { supplierId: input.supplier_id, branchId: input.branch_id });
  const open = states.filter((s) => s.wire.due_usd > 0 || s.wire.due_syp > 0);
  const chosen = input.invoice_ids;
  const ordered: OpenInvoice[] = (chosen && chosen.length > 0
    ? chosen.map((id) => open.find((s) => s.invoice.id === id)).filter((s): s is InvoiceState => s !== undefined)
    : open
  ).map((s) => ({ id: s.invoice.id, invoiceDate: s.invoice.invoiceDate, rate: s.invoice.rate, dueUsd: s.wire.due_usd, dueSyp: s.wire.due_syp }));
  if (chosen && chosen.length > 0 && ordered.length !== chosen.length) {
    throw new BusinessError(422, 'An invoice chosen owes nothing here', 'payable_invoice_not_open');
  }

  // The rate: dollars are worth today's buy rate; liras paying dollars, the agreed rate.
  const needsRate = input.currency === 'USD' || ordered.some((o) => o.dueUsd > 0);
  const rate =
    input.currency === 'USD'
      ? fx === null
        ? null
        : Number(fx.buy_rate)
      : (input.fx_rate ?? (fx === null ? null : Number(fx.sell_rate)));
  if (needsRate && (rate === null || rate <= 0)) {
    throw new BusinessError(422, 'No dollar rate is set', 'fx_rate_missing');
  }
  const split = allocatePayment(ordered, { currency: input.currency, amount: input.amount, rate: rate ?? 1 });
  const settings = await findSettings();
  if (split.leftover > 0 && !settings.overpay_to_credit_suppliers) {
    throw new BusinessError(422, 'More than is owed', 'payable_overpay_not_allowed', {
      leftover: split.leftover,
      currency: input.currency,
    });
  }
  const valueSyp = r2(input.currency === 'USD' ? input.amount * rate! : input.amount);
  const gain = r2(split.allocations.reduce((t, a) => t + a.gainSyp, 0));
  const note = input.note?.trim() || null;

  const write = async (tx: Tx, ref: { movementId: number | null; shiftId: number | null }) => {
    await repo.lockInvoices(tx, ordered.map((o) => o.id));
    // Re-read under the lock: two payers settling the same dollars must not both succeed.
    const fresh = await repo.findAllocatedByInvoice(tx, ordered.map((o) => o.id));
    for (const a of split.allocations) {
      if (a.invoiceId === null) continue;
      const before = states.find((s) => s.invoice.id === a.invoiceId)!;
      const now = fresh.get(a.invoiceId) ?? { paidUsd: 0, paidSyp: 0, gainSyp: 0 };
      if (Math.abs(now.paidUsd - before.wire.paid_usd) > 0.0001 || Math.abs(now.paidSyp - before.wire.paid_syp) > 0.01) {
        throw new BusinessError(409, 'Someone paid this invoice a moment ago — look again', 'payable_changed');
      }
    }
    const payment = await repo.insertPayment(tx, {
      branch_id: input.branch_id,
      supplier_id: input.supplier_id,
      currency: input.currency,
      amount: input.amount.toFixed(2),
      fx_rate: (rate ?? 1).toFixed(4),
      source: input.source,
      shift_id: ref.shiftId,
      movement_id: ref.movementId,
      note,
      created_by_user_id: actor.userId,
    });
    await repo.insertAllocations(tx, [
      ...split.allocations.map((a) => ({
        payment_id: payment.id,
        invoice_id: a.invoiceId,
        bucket: a.bucket,
        amount: a.amount.toFixed(4),
        fx_gain_syp: a.gainSyp.toFixed(2),
      })),
      ...(split.leftover > 0
        ? [{ payment_id: payment.id, invoice_id: null, bucket: input.currency, amount: split.leftover.toFixed(4), fx_gain_syp: '0' }]
        : []),
    ]);
    await recordFinance(tx, [
      // From outside: the payment's own entry (from the drawer, the movement booked it).
      ...(input.source === 'outside'
        ? [
            {
              branchId: input.branch_id,
              type: 'supplier_payment' as const,
              method: 'external' as const,
              amountSyp: -valueSyp,
              ...(input.currency === 'USD' ? { currency: 'USD' as const, amountFx: -input.amount, fxRate: rate } : {}),
              docType: 'supplier_payment' as const,
              docId: payment.id,
              userId: actor.userId,
              stationId: actor.stationId ?? null,
              note,
            },
          ]
        : []),
      {
        branchId: input.branch_id,
        type: 'fx_gain',
        method: 'value',
        amountSyp: gain,
        docType: 'supplier_payment',
        docId: payment.id,
        userId: actor.userId,
        stationId: actor.stationId ?? null,
        shiftId: ref.shiftId,
      },
    ]);
    return payment;
  };

  if (input.source === 'drawer') {
    await drawerCashOut(
      actor,
      input.branch_id,
      {
        amountSyp: valueSyp,
        usd: input.currency === 'USD' ? { amount: input.amount, rate: rate! } : undefined,
        reasonCode: 'supplier_payment',
        entryType: 'supplier_payment',
        note: note ?? supplier.name,
        requireKey: PAY_KEY,
      },
      approverUserId,
      async (tx, ref) => {
        await write(tx, ref);
      },
    );
  } else {
    await db.transaction(async (tx) => {
      await write(tx, { movementId: null, shiftId: null });
    });
  }
  await recordAudit(actor, SALES_AUDIT.supplierPay, saleTarget.supplier(input.supplier_id), null, {
    ...input,
    fx_rate: rate,
    fx_gain_syp: gain,
  });
  return getSupplierAccount(input.supplier_id);
}

/**
 * A wrong payment undone by its opposite — never edited: its allocations and
 * realized difference come back the other way, and drawer cash goes back into
 * the branch's open shift.
 */
export async function reversePayment(actor: RequestActorContext, paymentId: number, reason: string): Promise<WireSupplierAccount> {
  const payment = await repo.findPayment(db, paymentId);
  if (!payment) throw new NotFoundError('Payment not found');
  await requirePayAt(actor, payment.branch_id);
  if (payment.reverses_payment_id !== null) {
    throw new BusinessError(409, 'A correction is not corrected — pay again', 'payable_is_reversal');
  }
  const amount = Number(payment.amount);
  const rate = Number(payment.fx_rate);
  const usd = payment.currency === 'USD';
  const valueSyp = r2(usd ? amount * rate : amount);
  const write = async (tx: Tx, ref: { movementId: number | null; shiftId: number | null }): Promise<SupplierPaymentRow> => {
    if (await repo.findReversalOf(tx, paymentId)) {
      throw new BusinessError(409, 'This payment was already corrected', 'payable_already_reversed');
    }
    const allocations = await repo.findAllocationsOf(tx, [paymentId]);
    const back = await repo.insertPayment(tx, {
      branch_id: payment.branch_id,
      supplier_id: payment.supplier_id,
      currency: payment.currency,
      amount: (-amount).toFixed(2),
      fx_rate: payment.fx_rate,
      source: payment.source,
      shift_id: ref.shiftId,
      movement_id: ref.movementId,
      note: reason.trim(),
      reverses_payment_id: paymentId,
      created_by_user_id: actor.userId,
    });
    await repo.insertAllocations(
      tx,
      allocations.map((a) => ({
        payment_id: back.id,
        invoice_id: a.invoice_id,
        bucket: a.bucket,
        amount: (-Number(a.amount)).toFixed(4),
        fx_gain_syp: (-Number(a.fx_gain_syp)).toFixed(2),
      })),
    );
    const gain = r2(allocations.reduce((t, a) => t + Number(a.fx_gain_syp), 0));
    await recordFinance(tx, [
      ...(payment.source === 'outside'
        ? [
            {
              branchId: payment.branch_id,
              type: 'supplier_payment' as const,
              method: 'external' as const,
              amountSyp: valueSyp,
              ...(usd ? { currency: 'USD' as const, amountFx: amount, fxRate: rate } : {}),
              docType: 'supplier_payment' as const,
              docId: back.id,
              userId: actor.userId,
              stationId: actor.stationId ?? null,
              reason: 'reversal',
              note: reason.trim(),
            },
          ]
        : []),
      {
        branchId: payment.branch_id,
        type: 'fx_gain',
        method: 'value',
        amountSyp: -gain,
        docType: 'supplier_payment',
        docId: back.id,
        userId: actor.userId,
        stationId: actor.stationId ?? null,
        shiftId: ref.shiftId,
        reason: 'reversal',
      },
    ]);
    return back;
  };
  await db.transaction(async (tx) => {
    if (payment.source === 'drawer') {
      const ref = await drawerCashBack(
        tx,
        actor,
        payment.branch_id,
        {
          amountSyp: valueSyp,
          usd: usd ? { amount, rate } : undefined,
          reasonCode: 'supplier_payment',
          entryType: 'supplier_payment',
          note: reason.trim(),
        },
        payment.movement_id,
      );
      await write(tx, ref);
    } else {
      await write(tx, { movementId: null, shiftId: null });
    }
  });
  await recordAudit(actor, SALES_AUDIT.supplierPayReverse, saleTarget.supplier(payment.supplier_id), null, {
    payment_id: paymentId,
    reason,
  });
  return getSupplierAccount(payment.supplier_id);
}

/**
 * A dollar debt fixed in liras at a rate agreed with the supplier — the dollars
 * still owed on the invoice become liras, and the difference from the invoice's
 * rate is realized now.
 */
export async function convertInvoice(
  actor: RequestActorContext,
  invoiceId: number,
  input: { rate: number; note?: string },
): Promise<WireSupplierAccount> {
  const [state] = await invoiceStates(db, { invoiceId });
  if (!state) throw new NotFoundError('Invoice not found');
  await requirePayAt(actor, state.invoice.branchId);
  if (state.wire.due_usd <= 0) {
    throw new BusinessError(409, 'No dollars are owed on this invoice', 'payable_no_dollars');
  }
  const { amountSyp, gainSyp } = convertDebt(state.wire.due_usd, state.invoice.rate, input.rate);
  await db.transaction(async (tx) => {
    await repo.lockInvoices(tx, [invoiceId]);
    const fresh = await repo.findConvertedByInvoice(tx, [invoiceId]);
    if (Math.abs((fresh.get(invoiceId)?.usd ?? 0) - state.wire.converted_usd) > 0.0001) {
      throw new BusinessError(409, 'Someone changed this debt a moment ago — look again', 'payable_changed');
    }
    const conversion = await repo.insertConversion(tx, {
      invoice_id: invoiceId,
      amount_usd: state.wire.due_usd.toFixed(4),
      rate: input.rate.toFixed(4),
      amount_syp: amountSyp.toFixed(2),
      fx_gain_syp: gainSyp.toFixed(2),
      note: input.note?.trim() || null,
      created_by_user_id: actor.userId,
    });
    await recordFinance(tx, [
      {
        branchId: state.invoice.branchId,
        type: 'fx_gain',
        method: 'value',
        amountSyp: gainSyp,
        docType: 'supplier_conversion',
        docId: conversion.id,
        userId: actor.userId,
        stationId: actor.stationId ?? null,
      },
    ]);
  });
  await recordAudit(actor, SALES_AUDIT.supplierConvert, saleTarget.supplier(state.invoice.supplierId), null, {
    invoice_id: invoiceId,
    rate: input.rate,
    amount_usd: state.wire.due_usd,
    amount_syp: amountSyp,
  });
  return getSupplierAccount(state.invoice.supplierId);
}

export const paymentValue = (p: { currency: string; amount: string; fx_rate: string }): number =>
  r2(p.currency === 'USD' ? num(p.amount) * num(p.fx_rate) : num(p.amount));
