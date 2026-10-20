import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, ForbiddenError, NotFoundError } from '../../../core/http/api-error.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { recordFinance } from '../../../core/finance/finance-recorder.js';
import { SALES_AUDIT, saleTarget } from '../audit-actions.js';
import * as repo from '../repositories/sales.repository.js';
import { findSettings, saveSettings } from '../repositories/returns.repository.js';
import { creditOverdue, daysSince, oldestUnpaidAt, splitPayment, type LedgerMove } from './debt-rules.js';
import { creditAvailable, roundSyp, spendableCredit } from './sale-rules.js';
import { shiftForMoney } from './shifts.service.js';

/**
 * What customers owe us (`finance_operations.md` §١). One signed ledger per
 * customer — negative is owed to the shop — and every number here is read from
 * it; nothing is stored beside it to drift.
 */

/** How a debt is paid. Cash only today — a field from day one, so another way is a value, not a migration. */
export type DebtPaymentMethod = 'cash';

const SELL = 'sales.sell';

function movesOf(rows: { amount_syp: string; created_at: Date }[]): LedgerMove[] {
  return rows.map((r) => ({ amount: Number(r.amount_syp), at: r.created_at }));
}

export async function getCustomerAccount(customerId: number) {
  const [balance, limit, entries, moves, settings] = await Promise.all([
    repo.findCustomerBalance(customerId),
    repo.findCreditLimit(customerId),
    repo.findLedger(customerId, 100),
    repo.findLedgerMoves([customerId]),
    findSettings(),
  ]);
  const reversed = new Set(entries.map((e) => e.reverses_entry_id).filter((id): id is number => id !== null));
  const oldest = balance < 0 ? oldestUnpaidAt(movesOf(moves)) : null;
  return {
    customer_id: customerId,
    balance_syp: roundSyp(balance),
    limit_syp: limit,
    spendable_syp: roundSyp(spendableCredit(balance)),
    available_credit_syp: roundSyp(creditAvailable(balance, limit)),
    oldest_unpaid_at: oldest?.toISOString() ?? null,
    oldest_unpaid_days: oldest === null ? null : daysSince(oldest),
    credit_block_after_days: settings.credit_block_after_days,
    /** New on-account sales are refused — said before the cashier promises one. */
    credit_blocked: creditOverdue(oldest, settings.credit_block_after_days),
    overpay_to_credit: settings.overpay_to_credit_customers,
    entries: entries.map((e) => ({
      id: e.id,
      amount_syp: Number(e.amount_syp),
      reason: e.reason,
      sale_id: e.sale_id,
      sale_number: e.sale_number,
      note: e.note,
      branch_id: e.branch_id,
      branch_name: e.branch_name,
      created_by_name: e.created_by_name,
      reverses_entry_id: e.reverses_entry_id,
      reversed: reversed.has(e.id),
      created_at: e.created_at.toISOString(),
    })),
  };
}

/**
 * Who owes, oldest unpaid first — whoever has waited longest is the debt most
 * likely never to come back, and newest-first buries exactly that row.
 */
export async function listDebts(search: string | undefined, page: number, limit: number) {
  const debtors = await repo.findDebtors(search);
  const moves = await repo.findLedgerMoves(debtors.map((d) => d.customer_id));
  const byCustomer = new Map<number, typeof moves>();
  for (const m of moves) {
    const list = byCustomer.get(m.customer_id) ?? [];
    list.push(m);
    byCustomer.set(m.customer_id, list);
  }
  const rows = debtors.map((d) => {
    const own = byCustomer.get(d.customer_id) ?? [];
    const oldest = oldestUnpaidAt(movesOf(own));
    const lastPayment = [...own].reverse().find((m) => m.reason === 'debt_payment');
    const balance = Number(d.balance);
    const limitSyp = d.limit_syp === null ? null : Number(d.limit_syp);
    return {
      customer_id: d.customer_id,
      name: `${d.first_name} ${d.last_name}`.trim(),
      phone: d.phone,
      debt_syp: roundSyp(-balance),
      limit_syp: limitSyp,
      available_credit_syp: roundSyp(creditAvailable(balance, limitSyp)),
      oldest_unpaid_at: oldest?.toISOString() ?? null,
      oldest_unpaid_days: oldest === null ? null : daysSince(oldest),
      last_payment_at: lastPayment?.created_at.toISOString() ?? null,
    };
  });
  rows.sort((a, b) => (b.oldest_unpaid_days ?? -1) - (a.oldest_unpaid_days ?? -1) || b.debt_syp - a.debt_syp);
  const settings = await findSettings();
  const summary = {
    total_syp: roundSyp(rows.reduce((s, r) => s + r.debt_syp, 0)),
    customers: rows.length,
    over_30_days: rows.filter((r) => (r.oldest_unpaid_days ?? 0) > 30).length,
    blocked: rows.filter((r) =>
      creditOverdue(r.oldest_unpaid_at === null ? null : new Date(r.oldest_unpaid_at), settings.credit_block_after_days),
    ).length,
  };
  const start = (page - 1) * limit;
  return { items: rows.slice(start, start + limit), total: rows.length, summary };
}

/**
 * A customer pays off a debt at a till. The money goes into that branch's open
 * shift, so it is counted at the close under the name of who took it.
 * More than is owed follows the admin's setting: kept as credit, or refused.
 */
export async function payDebt(
  actor: RequestActorContext,
  customerId: number,
  input: { amount_syp: number; branch_id: number; method: DebtPaymentMethod; note?: string },
) {
  if (!(await holdsPermissionAt(actor.userId, SELL, input.branch_id))) {
    throw new ForbiddenError('You cannot take money at this branch', undefined, 'debt_not_at_branch');
  }
  const amount = roundSyp(input.amount_syp);
  const settings = await findSettings();
  const note = input.note?.trim() || null;
  await db.transaction(async (tx) => {
    const shiftId = await shiftForMoney(tx, input.branch_id);
    const balance = await repo.findCustomerBalance(customerId, tx);
    const { extra } = splitPayment(amount, balance);
    if (extra > 0 && !settings.overpay_to_credit_customers) {
      throw new BusinessError(422, 'More than the customer owes', 'debt_overpay_not_allowed', {
        debt_syp: roundSyp(Math.max(0, -balance)),
      });
    }
    const [entry] = await repo.insertLedgerEntries(tx, [
      {
        customer_id: customerId,
        amount_syp: String(amount),
        reason: 'debt_payment',
        branch_id: input.branch_id,
        note,
        created_by_user_id: actor.userId,
      },
    ]);
    await recordFinance(tx, [
      {
        branchId: input.branch_id,
        type: 'debt_payment',
        method: input.method,
        amountSyp: amount,
        docType: 'customer_ledger',
        docId: entry?.id ?? customerId,
        userId: actor.userId,
        stationId: actor.stationId ?? null,
        shiftId,
        note,
      },
    ]);
  });
  await recordAudit(actor, SALES_AUDIT.debtPay, saleTarget.customer(customerId), null, {
    amount_syp: amount,
    branch_id: input.branch_id,
    method: input.method,
  });
  return getCustomerAccount(customerId);
}

/**
 * Undo a payment or a correction — a manager answers a mistake with an
 * opposite row; the original stays, struck. A cash payment undone takes the
 * money back out of the branch's open shift.
 */
export async function reverseLedgerEntry(
  actor: RequestActorContext,
  customerId: number,
  entryId: number,
  reason: string,
) {
  await db.transaction(async (tx) => {
    const entry = await repo.findLedgerEntry(entryId, tx);
    if (!entry || entry.customer_id !== customerId) throw new NotFoundError('Ledger entry not found');
    if (entry.reason !== 'debt_payment' && entry.reason !== 'manual_adjustment') {
      // A sale on account is undone by a return — not by striking the ledger.
      throw new BusinessError(409, 'Only a payment or a correction is undone here', 'ledger_not_reversible');
    }
    if (entry.reverses_entry_id !== null) {
      throw new BusinessError(409, 'An undo cannot be undone', 'ledger_entry_is_reversal');
    }
    if (await repo.findLedgerReversalOf(entryId, tx)) {
      throw new BusinessError(409, 'Already undone', 'ledger_entry_already_reversed');
    }
    const amount = -Number(entry.amount_syp);
    const cashBack = entry.reason === 'debt_payment' && entry.branch_id !== null;
    const shiftId = cashBack ? await shiftForMoney(tx, entry.branch_id!) : null;
    const [row] = await repo.insertLedgerEntries(tx, [
      {
        customer_id: customerId,
        amount_syp: String(amount),
        reason: entry.reason,
        branch_id: entry.branch_id,
        reverses_entry_id: entryId,
        note: reason.trim(),
        created_by_user_id: actor.userId,
      },
    ]);
    if (cashBack) {
      await recordFinance(tx, [
        {
          branchId: entry.branch_id!,
          type: 'debt_payment',
          method: 'cash',
          amountSyp: roundSyp(amount),
          docType: 'customer_ledger',
          docId: row?.id ?? entryId,
          userId: actor.userId,
          stationId: actor.stationId ?? null,
          shiftId,
          note: reason.trim(),
        },
      ]);
    }
  });
  await recordAudit(actor, SALES_AUDIT.ledgerReverse, saleTarget.customer(customerId), null, {
    entry_id: entryId,
    reason,
  });
  return getCustomerAccount(customerId);
}

/** Refuses a new on-account sale for a customer whose oldest debt is past the admin's limit. */
export async function assertCreditNotOverdue(customerId: number): Promise<void> {
  const settings = await findSettings();
  if (settings.credit_block_after_days === null) return;
  const oldest = oldestUnpaidAt(movesOf(await repo.findLedgerMoves([customerId])));
  if (creditOverdue(oldest, settings.credit_block_after_days)) {
    throw new BusinessError(409, 'This customer has an overdue debt', 'sale_credit_overdue', {
      oldest_unpaid_days: oldest === null ? null : daysSince(oldest),
      block_after_days: settings.credit_block_after_days,
    });
  }
}

export async function getCreditSettings() {
  const s = await findSettings();
  return {
    credit_block_after_days: s.credit_block_after_days,
    overpay_to_credit_customers: s.overpay_to_credit_customers,
    overpay_to_credit_suppliers: s.overpay_to_credit_suppliers,
  };
}

export async function setCreditSettings(
  actor: RequestActorContext,
  input: {
    credit_block_after_days?: number | null;
    overpay_to_credit_customers?: boolean;
    overpay_to_credit_suppliers?: boolean;
  },
) {
  await saveSettings(input, actor.userId);
  await recordAudit(actor, SALES_AUDIT.creditSettings, saleTarget.settings(), null, input);
  return getCreditSettings();
}
