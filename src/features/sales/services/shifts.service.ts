import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { recordFinance } from '../../../core/finance/finance-recorder.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { issueNumber } from '../../../core/numbering/numbering.js';
import { branchPrefix } from '../../../core/records/branch-prefix.js';
import * as userRoleAssignmentsRepository from '../../identity/repositories/user-role-assignments.repository.js';
import { SALES_AUDIT, saleTarget } from '../audit-actions.js';
import * as returnsRepo from '../repositories/returns.repository.js';
import * as salesRepo from '../repositories/sales.repository.js';
import * as repo from '../repositories/shifts.repository.js';
import type { CashMovementRow, CashShiftRow } from '../schemas/shifts.schema.js';
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
  type ShiftReasonCode,
} from './shift-rules.js';

/**
 * The branch's cash drawer — `docs/reference/cash_shifts.md` §المرحلة الثانية.
 *
 * **One drawer per branch, one open shift.** Everyone who takes money at the
 * branch — the cashier at the computer, the manager on a phone, the print
 * clerk — takes it on that shift, and every entry carries who and which device.
 *
 * **The count is blind on the server, not only on the screen**: the expected
 * cash of an open shift is sent to nobody — any of them may be the one counting.
 */

export const SHIFT_MANAGE = 'sales.shift.manage';
export const SHIFT_CLOSE = 'sales.shift.close';
const SELL = 'sales.sell';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const money = (v: number): string => v.toFixed(2);

export interface WireShift {
  id: number;
  number: string;
  branch_id: number;
  branch_name: string | null;
  opened_by_user_id: number;
  opened_by_name: string | null;
  status: 'open' | 'closed';
  opened_at: string;
  opened_station_name: string | null;
  opening_suggested_syp: number | null;
  opening_counted_syp: number;
  opening_difference_syp: number | null;
  closed_at: string | null;
  closed_by_name: string | null;
  closed_station_name: string | null;
  counted_syp: number | null;
  left_in_drawer_syp: number | null;
  deposited_syp: number | null;
  /** `null` while the shift is open — for everyone: the blind count. */
  expected_syp: number | null;
  difference_syp: number | null;
  reason_required: boolean;
  reason_code: ShiftReasonCode | null;
  reason: string | null;
  /** A reason was asked for and not given yet. */
  needs_reason: boolean;
  /** The difference passed the review threshold. */
  needs_review: boolean;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  is_stale: boolean;
  hours_open: number;
}

export interface WireShiftMovement {
  id: number;
  direction: 'in' | 'out';
  amount_syp: number;
  reason_code: string;
  note: string | null;
  user_id: number | null;
  user_name: string | null;
  station_name: string | null;
  approved_by_name: string | null;
  /** This movement undoes another one. */
  reverses_movement_id: number | null;
  /** Another movement undid this one. */
  reversed: boolean;
  created_at: string;
}

export interface WireShiftPerson {
  user_id: number | null;
  name: string | null;
  /** `null` = a phone or an unregistered computer. */
  station_name: string | null;
  sales_syp: number;
  cash_sales_syp: number;
  refunds_syp: number;
  cash_in_syp: number;
  cash_out_syp: number;
  debt_payments_syp: number;
}

export interface WireShiftReport {
  shift: WireShift;
  sales_count: number;
  revenue: Record<'cash' | 'card' | 'customer_credit' | 'on_account', number>;
  refunds: Record<'cash' | 'customer_credit', number>;
  cash_in: number;
  cash_out: number;
  debt_payments: number;
  by_person: WireShiftPerson[];
  movements: WireShiftMovement[];
}

async function wireShifts(rows: CashShiftRow[]): Promise<WireShift[]> {
  if (rows.length === 0) return [];
  const settings = await returnsRepo.findSettings();
  const userIds = [
    ...new Set(
      rows.flatMap((r) =>
        [r.cashier_user_id, r.closed_by_user_id, r.reviewed_by_user_id].filter((u): u is number => u !== null),
      ),
    ),
  ];
  const stationIds = [
    ...new Set(rows.flatMap((r) => [r.opened_station_id, r.closed_station_id].filter((s): s is number => s !== null))),
  ];
  const [users, stations, branches] = await Promise.all([
    salesRepo.findUserNames(userIds),
    salesRepo.findStationNames(stationIds),
    salesRepo.findBranchNames([...new Set(rows.map((r) => r.branch_id))]),
  ]);
  const now = new Date();
  return rows.map((r) => {
    const counted = num(r.counted_syp);
    const left = num(r.left_in_drawer_syp);
    const open = r.status === 'open';
    return {
      id: r.id,
      number: r.number,
      branch_id: r.branch_id,
      branch_name: branches.get(r.branch_id) ?? null,
      opened_by_user_id: r.cashier_user_id,
      opened_by_name: users.get(r.cashier_user_id) ?? null,
      status: r.status,
      opened_at: r.opened_at.toISOString(),
      opened_station_name: r.opened_station_id === null ? null : (stations.get(r.opened_station_id) ?? null),
      opening_suggested_syp: num(r.opening_suggested_syp),
      opening_counted_syp: Number(r.opening_counted_syp),
      opening_difference_syp: openingDifference(num(r.opening_suggested_syp), Number(r.opening_counted_syp)),
      closed_at: r.closed_at?.toISOString() ?? null,
      closed_by_name: r.closed_by_user_id === null ? null : (users.get(r.closed_by_user_id) ?? null),
      closed_station_name: r.closed_station_id === null ? null : (stations.get(r.closed_station_id) ?? null),
      counted_syp: counted,
      left_in_drawer_syp: left,
      deposited_syp: counted === null || left === null ? null : depositedOf(counted, left),
      // Frozen at close; an open shift's expected leaves the server for nobody.
      expected_syp: open ? null : num(r.expected_syp),
      difference_syp: num(r.difference_syp),
      reason_required: r.reason_required,
      reason_code: (r.reason_code as ShiftReasonCode | null) ?? null,
      reason: r.reason,
      needs_reason: r.reason_required && r.reason_code === null && (r.reason === null || r.reason.trim() === ''),
      needs_review: r.needs_review,
      reviewed_by_name: r.reviewed_by_user_id === null ? null : (users.get(r.reviewed_by_user_id) ?? null),
      reviewed_at: r.reviewed_at?.toISOString() ?? null,
      is_stale: open && isStale(r.opened_at, settings.shift_alert_hours, now),
      hours_open: hoursOpen(r.opened_at, r.closed_at ?? now),
    };
  });
}

async function wireOne(row: CashShiftRow): Promise<WireShift> {
  return (await wireShifts([row]))[0]!;
}

/** Refuses unless [actor] holds [key] at [branchId] — the route checks the key, this checks the place. */
async function requireAt(actor: RequestActorContext, key: string, branchId: number): Promise<void> {
  if (!(await holdsPermissionAt(actor.userId, key, branchId))) {
    throw new BusinessError(403, 'Not at this branch', 'shift_not_at_branch');
  }
}

// ── The till's side ────────────────────────────────────────────────────────

/**
 * The shift a payment, a refund or a cash debt payment falls in — the
 * **branch's** open one, whoever takes the money. Called **inside** the paying
 * transaction. No open shift: refused (`shift_required`) — the till opens one
 * and pays again. A shift past the alert with the setting on `block`: refused
 * (`shift_stale`) until it is counted.
 */
export async function shiftForMoney(tx: Tx, branchId: number): Promise<number> {
  const open = await repo.findOpenShift(tx, branchId, 'share');
  if (!open) {
    throw new BusinessError(409, 'Open the branch drawer before taking money', 'shift_required', { branch_id: branchId });
  }
  const settings = await returnsRepo.findSettings();
  if (blocksMoney(open.opened_at, settings.shift_alert_hours, settings.shift_stale_action)) {
    throw new BusinessError(409, 'The drawer has been open too long — count it first', 'shift_stale', {
      shift_id: open.id,
      alert_hours: settings.shift_alert_hours,
    });
  }
  return open.id;
}

export interface WireCurrentShift {
  /** Always `required` — kept on the wire for the screens that read it. */
  mode: 'required';
  alert_hours: number;
  stale_action: 'warn' | 'block';
  /** A cash-out above this needs a manager — said before the cashier types. `null` = no cap, or the reader is one. */
  cash_out_approval_syp: number | null;
  /** The notes the optional counter shows. */
  denominations: number[];
  /** What the last close left in the drawer — the opening to suggest. */
  suggested_opening_syp: number | null;
  /** Carts still building or parked at the branch — warned about at close. */
  open_carts: number;
  /** Whether the reader may count and close the drawer here. */
  can_close: boolean;
  shift: WireShift | null;
}

export async function getCurrent(actor: RequestActorContext, branchId: number): Promise<WireCurrentShift> {
  await requireAt(actor, SELL, branchId);
  const [settings, open, canClose, openCarts, manages] = await Promise.all([
    returnsRepo.findSettings(),
    repo.findOpenShift(db, branchId),
    holdsPermissionAt(actor.userId, SHIFT_CLOSE, branchId),
    repo.countOpenCarts(branchId),
    holdsPermissionAt(actor.userId, SHIFT_MANAGE, branchId),
  ]);
  return {
    mode: 'required',
    alert_hours: settings.shift_alert_hours,
    stale_action: settings.shift_stale_action,
    // A manager here is the approval itself — no cap to say.
    cash_out_approval_syp: manages ? null : settings.shift_cash_out_approval_syp,
    denominations: settings.shift_denominations,
    suggested_opening_syp: open ? null : await repo.findLastLeft(branchId),
    open_carts: openCarts,
    can_close: canClose,
    shift: open ? await wireOne(open) : null,
  };
}

/**
 * Opens the branch's drawer. **When it is already open, answers with that
 * shift** — two people opening at once (or a screen that did not know) land on
 * the same drawer, and the second count is not recorded: only the first opener
 * counted an empty-handed drawer.
 */
export async function openShift(
  actor: RequestActorContext,
  input: { branch_id: number; opening_counted_syp: number },
): Promise<WireShift> {
  const branch = await salesRepo.findBranch(input.branch_id);
  if (!branch) throw new NotFoundError('Branch not found');
  await requireAt(actor, SELL, input.branch_id);
  const existing = await repo.findOpenShift(db, input.branch_id);
  if (existing) return wireOne(existing);
  const suggested = await repo.findLastLeft(input.branch_id);
  let row: CashShiftRow;
  try {
    row = await db.transaction(async (tx) => {
      const { number, sequence } = await issueNumber(tx, 'shift', branchPrefix(branch.code, branch.id));
      const created = await repo.insertShift(tx, {
        branch_id: input.branch_id,
        cashier_user_id: actor.userId,
        number,
        sequence,
        opened_station_id: actor.stationId ?? null,
        opening_suggested_syp: suggested === null ? null : money(suggested),
        opening_counted_syp: money(input.opening_counted_syp),
      });
      // «Left 50, found 45» — the drawer lost money between two shifts.
      const diff = openingDifference(suggested, input.opening_counted_syp);
      if (diff !== null && diff !== 0) {
        await recordFinance(tx, [
          {
            branchId: input.branch_id,
            type: diff > 0 ? 'cash_over' : 'cash_short',
            method: 'cash',
            amountSyp: diff,
            docType: 'cash_shift',
            docId: created.id,
            userId: actor.userId,
            stationId: actor.stationId ?? null,
            shiftId: created.id,
            reason: 'opening',
          },
        ]);
      }
      return created;
    });
  } catch (e) {
    // Two openers racing past the check above: the unique index answers, and
    // the second gets the drawer the first opened.
    if ((e as { code?: string }).code === '23505') {
      const raced = await repo.findOpenShift(db, input.branch_id);
      if (raced) return wireOne(raced);
    }
    throw e;
  }
  await recordAudit(actor, SALES_AUDIT.shiftOpen, saleTarget.shift(row.id), null, {
    opening_counted_syp: input.opening_counted_syp,
    opening_suggested_syp: suggested,
  });
  return wireOne(row);
}

/** What the drawer holds right now — inside the transaction that holds the shift's lock. */
async function drawerNow(tx: Tx, shift: CashShiftRow): Promise<number> {
  return expectedCash(Number(shift.opening_counted_syp), await repo.findCashEntries(tx, shift.id));
}

/**
 * Cash put in or taken out by hand — by anyone who sells at the branch, under
 * their own name. **A cash-out never takes more than the drawer holds**
 * (`cash_out_exceeds_drawer`, the amount not said), and above the cap it needs
 * a manager who approves on this device ([approverUserId], verified by the route).
 */
export async function addMovement(
  actor: RequestActorContext,
  shiftId: number,
  input: { direction: 'in' | 'out'; amount_syp: number; reason_code: string; note?: string },
  approverUserId: number | null = null,
): Promise<WireShiftReport> {
  const shift = await repo.findShiftById(db, shiftId);
  if (!shift) throw new NotFoundError('Shift not found');
  await requireAt(actor, SELL, shift.branch_id);
  const out = input.direction === 'out';
  if (out && input.reason_code === 'expense') {
    // An expense lowers profit and names its category — the expense form books it
    // (`finance_operations.md` §٢); a bare cash-out would leave profit too high.
    throw new BusinessError(409, 'Record an expense from the expense form', 'shift_use_expense_form');
  }
  const settings = await returnsRepo.findSettings();
  // The drawer first: asking a manager to approve what the drawer cannot give
  // spends their password on a refusal. Re-checked under the lock below.
  if (out && shift.status === 'open') {
    const now = expectedCash(Number(shift.opening_counted_syp), await repo.findCashEntries(db, shift.id));
    if (!cashOutFits(input.amount_syp, now)) {
      throw new BusinessError(409, 'The drawer does not hold that much', 'cash_out_exceeds_drawer');
    }
  }
  // A manager at the branch is the approval the cap asks for — recorded under
  // their own name. Anyone else needs a manager **other than themselves**.
  const selfManages = out && (await holdsPermissionAt(actor.userId, SHIFT_MANAGE, shift.branch_id));
  if (selfManages) approverUserId = actor.userId;
  else if (out && cashOutNeedsApproval(input.amount_syp, settings.shift_cash_out_approval_syp)) {
    if (approverUserId === actor.userId) {
      throw new BusinessError(403, 'You cannot approve your own cash-out', 'shift_approver_is_self');
    }
    if (approverUserId === null) {
      throw new BusinessError(409, 'This cash-out needs a manager', 'shift_cash_out_needs_approval', {
        cap_syp: settings.shift_cash_out_approval_syp,
      });
    }
    if (!(await holdsPermissionAt(approverUserId, SHIFT_MANAGE, shift.branch_id))) {
      throw new BusinessError(403, 'This approver may not approve cash-outs here', 'shift_approver_not_allowed');
    }
  }
  await db.transaction(async (tx) => {
    const locked = await repo.lockShift(tx, shiftId);
    if (!locked || locked.status !== 'open') {
      throw new BusinessError(409, 'This shift is closed', 'shift_closed');
    }
    if (out && !cashOutFits(input.amount_syp, await drawerNow(tx, locked))) {
      throw new BusinessError(409, 'The drawer does not hold that much', 'cash_out_exceeds_drawer');
    }
    await bookMovement(tx, actor, locked, {
      direction: input.direction,
      amountSyp: input.amount_syp,
      reasonCode: input.reason_code,
      note: input.note?.trim() || null,
      reversesId: null,
      approvedBy: out && approverUserId !== null ? approverUserId : null,
    });
  });
  await recordAudit(actor, SALES_AUDIT.shiftMovement, saleTarget.shift(shiftId), null, {
    ...input,
    approved_by: approverUserId,
  });
  return getReport(actor, shiftId);
}

/**
 * An expense paid from the branch's drawer (`finance_operations.md` §٢) — the
 * same rules as a cash-out: the open shift, the drawer holding it, the cap and
 * a manager's approval (a manager at the branch approves their own). The
 * movement and its `expense` entry are booked, then [write] records the
 * expense row **in the same transaction**.
 */
export async function drawerExpenseOut(
  actor: RequestActorContext,
  branchId: number,
  amountSyp: number,
  note: string | null,
  approverUserId: number | null,
  write: (tx: Tx, ref: { movementId: number; shiftId: number }) => Promise<void>,
): Promise<void> {
  await requireAt(actor, SELL, branchId);
  const shift = await repo.findOpenShift(db, branchId);
  if (!shift) throw new BusinessError(409, 'Open the branch drawer first', 'shift_required');
  const settings = await returnsRepo.findSettings();
  if (!cashOutFits(amountSyp, expectedCash(Number(shift.opening_counted_syp), await repo.findCashEntries(db, shift.id)))) {
    throw new BusinessError(409, 'The drawer does not hold that much', 'cash_out_exceeds_drawer');
  }
  if (await holdsPermissionAt(actor.userId, SHIFT_MANAGE, branchId)) approverUserId = actor.userId;
  else if (cashOutNeedsApproval(amountSyp, settings.shift_cash_out_approval_syp)) {
    if (approverUserId === actor.userId) {
      throw new BusinessError(403, 'You cannot approve your own cash-out', 'shift_approver_is_self');
    }
    if (approverUserId === null) {
      throw new BusinessError(409, 'This cash-out needs a manager', 'shift_cash_out_needs_approval', {
        cap_syp: settings.shift_cash_out_approval_syp,
      });
    }
    if (!(await holdsPermissionAt(approverUserId, SHIFT_MANAGE, branchId))) {
      throw new BusinessError(403, 'This approver may not approve cash-outs here', 'shift_approver_not_allowed');
    }
  }
  await db.transaction(async (tx) => {
    const locked = await repo.lockShift(tx, shift.id);
    if (!locked || locked.status !== 'open') throw new BusinessError(409, 'This shift is closed', 'shift_closed');
    if (!cashOutFits(amountSyp, await drawerNow(tx, locked))) {
      throw new BusinessError(409, 'The drawer does not hold that much', 'cash_out_exceeds_drawer');
    }
    const movement = await bookMovement(tx, actor, locked, {
      direction: 'out',
      amountSyp,
      reasonCode: 'expense',
      note,
      reversesId: null,
      approvedBy: approverUserId,
      expense: true,
    });
    await write(tx, { movementId: movement.id, shiftId: locked.id });
  });
}

/**
 * An expense from the drawer undone — the cash goes back into the branch's
 * open shift (today's, if the original one was counted) as an `expense` entry
 * the other way, so profit and the drawer both come back.
 */
export async function drawerExpenseBack(
  tx: Tx,
  actor: RequestActorContext,
  branchId: number,
  amountSyp: number,
  note: string,
  originalMovementId: number | null,
): Promise<{ movementId: number; shiftId: number }> {
  const shiftId = await shiftForMoney(tx, branchId);
  const locked = await repo.lockShift(tx, shiftId);
  if (!locked) throw new BusinessError(409, 'Open the branch drawer first', 'shift_required');
  // Only a movement of this shift is undone as such — one of a counted shift comes back as a new entry.
  const sameShift = originalMovementId !== null && (await repo.findMovementById(tx, originalMovementId))?.shift_id === locked.id;
  const movement = await bookMovement(tx, actor, locked, {
    direction: 'in',
    amountSyp,
    reasonCode: 'expense',
    note,
    reversesId: sameShift ? originalMovementId : null,
    approvedBy: null,
    expense: true,
  });
  return { movementId: movement.id, shiftId: locked.id };
}

/**
 * Undoes a wrong movement with its opposite — **never an edit or a delete**:
 * the record keeps both, and the report says which undid which. Once per
 * movement, while the shift is open, by whoever booked it or whoever may close
 * the drawer.
 */
export async function reverseMovement(
  actor: RequestActorContext,
  shiftId: number,
  movementId: number,
): Promise<WireShiftReport> {
  const shift = await repo.findShiftById(db, shiftId);
  if (!shift) throw new NotFoundError('Shift not found');
  const movement = await repo.findMovementById(db, movementId);
  if (!movement || movement.shift_id !== shiftId) throw new NotFoundError('Movement not found');
  if (movement.reverses_movement_id !== null) {
    throw new BusinessError(409, 'A reversal is not reversed — book the movement again', 'shift_movement_is_reversal');
  }
  const mine = movement.user_id === actor.userId;
  if (!mine) await requireAt(actor, SHIFT_CLOSE, shift.branch_id);
  else await requireAt(actor, SELL, shift.branch_id);
  await db.transaction(async (tx) => {
    const locked = await repo.lockShift(tx, shiftId);
    if (!locked || locked.status !== 'open') {
      throw new BusinessError(409, 'This shift is closed', 'shift_closed');
    }
    if (await repo.findReversalOf(tx, movementId)) {
      throw new BusinessError(409, 'This movement was already reversed', 'shift_movement_already_reversed');
    }
    const direction = movement.direction === 'in' ? 'out' : 'in';
    const amount = Number(movement.amount_syp);
    // Taking back cash that was put in still cannot empty the drawer below zero.
    if (direction === 'out' && !cashOutFits(amount, await drawerNow(tx, locked))) {
      throw new BusinessError(409, 'The drawer does not hold that much', 'cash_out_exceeds_drawer');
    }
    await bookMovement(tx, actor, locked, {
      direction,
      amountSyp: amount,
      reasonCode: movement.reason_code,
      note: null,
      reversesId: movementId,
      approvedBy: null,
    });
  });
  await recordAudit(actor, SALES_AUDIT.shiftReverse, saleTarget.shift(shiftId), null, { movement_id: movementId });
  return getReport(actor, shiftId);
}

async function bookMovement(
  tx: Tx,
  actor: RequestActorContext,
  shift: CashShiftRow,
  m: {
    direction: 'in' | 'out';
    amountSyp: number;
    reasonCode: string;
    note: string | null;
    reversesId: number | null;
    approvedBy: number | null;
    /** An expense paid from the drawer books `expense` — it lowers profit, a cash-out does not. */
    expense?: boolean;
  },
): Promise<CashMovementRow> {
  const movement = await repo.insertMovement(tx, {
    shift_id: shift.id,
    direction: m.direction,
    amount_syp: money(m.amountSyp),
    reason_code: m.reasonCode,
    note: m.note,
    user_id: actor.userId,
    station_id: actor.stationId ?? null,
    reverses_movement_id: m.reversesId,
    approved_by_user_id: m.approvedBy,
  });
  await recordFinance(tx, [
    {
      branchId: shift.branch_id,
      type: m.expense ? 'expense' : m.direction === 'in' ? 'cash_in' : 'cash_out',
      method: 'cash',
      amountSyp: m.direction === 'in' ? m.amountSyp : -m.amountSyp,
      docType: 'cash_movement',
      docId: movement.id,
      userId: actor.userId,
      stationId: actor.stationId ?? null,
      shiftId: shift.id,
      reason: m.reversesId === null ? m.reasonCode : 'reversal',
      note: m.note,
    },
  ]);
  return movement;
}

export interface CloseResult {
  shift: WireShift;
  /** The close crossed the threshold — the till asks for the reason now. */
  needs_reason: boolean;
}

/**
 * Closes the branch's drawer on its blind count — by whoever holds
 * `sales.shift.close` here (the route checks the key, this the branch).
 * **Always closes**: a reason the threshold asks for is attached after
 * (`PUT /:id/reason`); asking before would show the expected and let the count
 * be typed again to match it. The difference is booked under the closer.
 */
export async function closeShift(
  actor: RequestActorContext,
  shiftId: number,
  input: { counted_syp: number; left_in_drawer_syp: number },
): Promise<CloseResult> {
  if (input.left_in_drawer_syp > input.counted_syp) {
    throw new BusinessError(422, 'Cannot leave more than was counted', 'shift_left_above_counted');
  }
  const shift = await repo.findShiftById(db, shiftId);
  if (!shift) throw new NotFoundError('Shift not found');
  await requireAt(actor, SHIFT_CLOSE, shift.branch_id);
  const settings = await returnsRepo.findSettings();

  const closed = await db.transaction(async (tx) => {
    const locked = await repo.lockShift(tx, shiftId);
    if (!locked || locked.status !== 'open') {
      throw new BusinessError(409, 'This shift is already closed', 'shift_closed');
    }
    const expected = await drawerNow(tx, locked);
    const difference = differenceOf(input.counted_syp, expected);
    const asks = needsReason(difference, settings.shift_reason_above_syp);
    await repo.updateShift(tx, shiftId, {
      status: 'closed',
      closed_at: new Date(),
      closed_by_user_id: actor.userId,
      closed_station_id: actor.stationId ?? null,
      counted_syp: money(input.counted_syp),
      left_in_drawer_syp: money(input.left_in_drawer_syp),
      expected_syp: money(expected),
      difference_syp: money(difference),
      reason_required: asks,
      needs_review: needsReview(difference, settings.shift_review_above_syp),
    });
    if (difference !== 0) {
      await recordFinance(tx, [
        {
          branchId: locked.branch_id,
          type: difference > 0 ? 'cash_over' : 'cash_short',
          method: 'cash',
          amountSyp: difference,
          docType: 'cash_shift',
          docId: shiftId,
          userId: actor.userId,
          stationId: actor.stationId ?? null,
          shiftId,
          reason: 'count',
        },
      ]);
    }
    return { asks };
  });
  await recordAudit(actor, SALES_AUDIT.shiftClose, saleTarget.shift(shiftId), null, input);
  const after = (await repo.findShiftById(db, shiftId))!;
  return { shift: await wireOne(after), needs_reason: closed.asks };
}

/** The reason a close asked for — once, by the closer or a manager, as a code (+ a note for «other»). */
export async function setReason(
  actor: RequestActorContext,
  shiftId: number,
  input: { reason_code: ShiftReasonCode; note?: string },
): Promise<WireShift> {
  const shift = await repo.findShiftById(db, shiftId);
  if (!shift) throw new NotFoundError('Shift not found');
  if (shift.status !== 'closed') throw new BusinessError(409, 'The shift is still open', 'shift_open');
  if (shift.closed_by_user_id !== actor.userId) await requireAt(actor, SHIFT_MANAGE, shift.branch_id);
  if (shift.reason_code !== null || (shift.reason !== null && shift.reason.trim() !== '')) {
    // The record is not rewritten — a second reason would erase what was said first.
    throw new BusinessError(409, 'This shift already has its reason', 'shift_reason_set');
  }
  const note = input.note?.trim() || null;
  await db.transaction(async (tx) => {
    await repo.updateShift(tx, shiftId, { reason_code: input.reason_code, reason: note });
  });
  await recordAudit(actor, SALES_AUDIT.shiftReason, saleTarget.shift(shiftId), null, input);
  return wireOne((await repo.findShiftById(db, shiftId))!);
}

/** A manager looked at a flagged difference — it leaves the «needs review» list. Once. */
export async function reviewShift(actor: RequestActorContext, shiftId: number): Promise<WireShift> {
  const shift = await repo.findShiftById(db, shiftId);
  if (!shift) throw new NotFoundError('Shift not found');
  await requireAt(actor, SHIFT_MANAGE, shift.branch_id);
  if (shift.status !== 'closed' || !shift.needs_review || shift.reviewed_at !== null) {
    throw new BusinessError(409, 'This shift is not waiting for a review', 'shift_not_reviewable');
  }
  await db.transaction(async (tx) => {
    await repo.updateShift(tx, shiftId, { reviewed_by_user_id: actor.userId, reviewed_at: new Date() });
  });
  await recordAudit(actor, SALES_AUDIT.shiftReview, saleTarget.shift(shiftId), null, null);
  return wireOne((await repo.findShiftById(db, shiftId))!);
}

// ── Reading ────────────────────────────────────────────────────────────────

/** The shift's report — for anyone who sells at its branch (it is their drawer too) or manages it. */
export async function getReport(actor: RequestActorContext, shiftId: number): Promise<WireShiftReport> {
  const shift = await repo.findShiftById(db, shiftId);
  if (!shift) throw new NotFoundError('Shift not found');
  const [sells, manages] = await Promise.all([
    holdsPermissionAt(actor.userId, SELL, shift.branch_id),
    holdsPermissionAt(actor.userId, SHIFT_MANAGE, shift.branch_id),
  ]);
  if (!sells && !manages) throw new BusinessError(403, 'Not at this branch', 'shift_not_at_branch');
  const [totals, salesCount, movements, personEntries] = await Promise.all([
    repo.findTotalsByTypeMethod(shiftId),
    repo.countSales(shiftId),
    repo.findMovements(shiftId),
    repo.findPersonEntries(shiftId),
  ]);
  const sum = (type: string, method?: string) =>
    totals.filter((t) => t.type === type && (method === undefined || t.method === method)).reduce((s, t) => s + t.totalSyp, 0);
  // A reversed movement and its reversal cancel out — neither is anyone's doing.
  // Left in, the reversal reads as the reverser taking the cash out themselves.
  const cancelled = new Set<number>();
  for (const m of movements) {
    if (m.reverses_movement_id !== null) {
      cancelled.add(m.id);
      cancelled.add(m.reverses_movement_id);
    }
  }
  const live = movements.filter((m) => !cancelled.has(m.id));
  const people = byPerson(
    personEntries.filter((e) => !(e.docType === 'cash_movement' && e.docId !== null && cancelled.has(e.docId))),
  );
  const userIds = new Set<number>();
  const stationIds = new Set<number>();
  for (const p of people) {
    if (p.userId !== null) userIds.add(p.userId);
    if (p.stationId !== null) stationIds.add(p.stationId);
  }
  for (const m of movements) {
    if (m.user_id !== null) userIds.add(m.user_id);
    if (m.approved_by_user_id !== null) userIds.add(m.approved_by_user_id);
    if (m.station_id !== null) stationIds.add(m.station_id);
  }
  const [users, stations] = await Promise.all([
    salesRepo.findUserNames([...userIds]),
    salesRepo.findStationNames([...stationIds]),
  ]);
  const reversedIds = new Set(movements.flatMap((m) => (m.reverses_movement_id === null ? [] : [m.reverses_movement_id])));
  return {
    shift: await wireOne(shift),
    sales_count: salesCount,
    revenue: {
      cash: sum('sale_revenue', 'cash'),
      card: sum('sale_revenue', 'card'),
      customer_credit: sum('sale_revenue', 'customer_credit'),
      on_account: sum('sale_revenue', 'on_account'),
    },
    refunds: {
      cash: -sum('refund', 'cash'),
      customer_credit: -sum('refund', 'customer_credit'),
    },
    // From the movements that stand — the list below still shows the cancelled pairs.
    cash_in: live.filter((m) => m.direction === 'in').reduce((s, m) => s + Number(m.amount_syp), 0),
    cash_out: live.filter((m) => m.direction === 'out').reduce((s, m) => s + Number(m.amount_syp), 0),
    debt_payments: sum('debt_payment'),
    by_person: people.map((p) => ({
      user_id: p.userId,
      name: p.userId === null ? null : (users.get(p.userId) ?? null),
      station_name: p.stationId === null ? null : (stations.get(p.stationId) ?? null),
      sales_syp: p.salesSyp,
      cash_sales_syp: p.cashSalesSyp,
      refunds_syp: p.refundsSyp,
      cash_in_syp: p.cashInSyp,
      cash_out_syp: p.cashOutSyp,
      debt_payments_syp: p.debtPaymentsSyp,
    })),
    movements: movements.map((m) => ({
      id: m.id,
      direction: m.direction,
      amount_syp: Number(m.amount_syp),
      reason_code: m.reason_code,
      note: m.note,
      user_id: m.user_id,
      user_name: m.user_id === null ? null : (users.get(m.user_id) ?? null),
      station_name: m.station_id === null ? null : (stations.get(m.station_id) ?? null),
      approved_by_name: m.approved_by_user_id === null ? null : (users.get(m.approved_by_user_id) ?? null),
      reverses_movement_id: m.reverses_movement_id,
      reversed: reversedIds.has(m.id),
      created_at: m.created_at.toISOString(),
    })),
  };
}

export interface ShiftsFilters {
  branchId?: number;
  cashierUserId?: number;
  status?: 'open' | 'closed';
  from?: Date;
  to?: Date;
  withDifference?: boolean;
  needsReview?: boolean;
}

/** Branches where the reader holds `sales.shift.manage`, narrowed to [branchId]. */
async function managedBranchIds(actor: RequestActorContext, branchId?: number): Promise<number[]> {
  const live = await repo.findLiveBranchIds();
  const held = await userRoleAssignmentsRepository.findEffectivePermissionKeysByBranch(actor.userId, live);
  const ids = live.filter((b) => held.get(b)?.has(SHIFT_MANAGE));
  return branchId === undefined ? ids : ids.filter((b) => b === branchId);
}

/** The manager's list — only branches where the reader holds `sales.shift.manage`. */
export async function listShifts(
  actor: RequestActorContext,
  filters: ShiftsFilters,
  limit: number,
  offset: number,
): Promise<{ items: WireShift[]; total: number }> {
  const branchIds = await managedBranchIds(actor, filters.branchId);
  const { rows, total } = await repo.findShifts({ ...filters, branchIds }, limit, offset);
  return { items: await wireShifts(rows), total };
}

export interface WireShiftsSummary {
  with_difference: number;
  waiting_review: number;
  short_syp: number;
  over_syp: number;
}

/** The line above the manager's list — over the same filters, without the page. */
export async function shiftsSummary(actor: RequestActorContext, filters: ShiftsFilters): Promise<WireShiftsSummary> {
  const branchIds = await managedBranchIds(actor, filters.branchId);
  const s = await repo.findShiftsSummary({ ...filters, branchIds });
  return { with_difference: s.withDifference, waiting_review: s.waitingReview, short_syp: s.shortSyp, over_syp: s.overSyp };
}
