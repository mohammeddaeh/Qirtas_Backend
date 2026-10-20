import type { Request, Response } from 'express';
import { verifyPassword } from '../../../core/auth/services/password.service.js';
import { staffRealm } from '../../../core/auth/realm.js';
import { BusinessError } from '../../../core/http/api-error.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { created, ok } from '../../../core/http/response.js';
import { paginated, toPaginationParams } from '../../../core/pagination/pagination.js';
import type { ShiftsQuery } from '../dtos/sales.dto.js';
import * as service from '../services/shifts.service.js';
import type { ShiftReasonCode } from '../services/shift-rules.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idOf = (req: Request) => (req.params as unknown as { id: number }).id;

export async function current(req: Request, res: Response): Promise<void> {
  const { branch_id: branchId } = req.query as unknown as { branch_id: number };
  ok(res, await service.getCurrent(actorOf(req), branchId));
}

export async function open(req: Request, res: Response): Promise<void> {
  created(res, await service.openShift(actorOf(req), req.body as { branch_id: number; opening_counted_syp: number; opening_counted_usd?: number }));
}

interface MovementBody {
  direction: 'in' | 'out';
  currency?: 'SYP' | 'USD';
  amount_syp?: number;
  amount_usd?: number;
  reason_code: string;
  note?: string;
  approver_email?: string;
  approver_password?: string;
}

/**
 * A cash-out above the cap carries the manager's email and password, checked
 * here on the cashier's device — the discount approval's way. **One refusal for
 * every cause** (unknown email, wrong password, inactive account): telling them
 * apart tells whoever tries which emails exist.
 */
export async function addMovement(req: Request, res: Response): Promise<void> {
  const { approver_email: email, approver_password: password, ...movement } = req.body as MovementBody;
  let approverId: number | null = null;
  if (email !== undefined || password !== undefined) {
    const account = email ? await staffRealm().store.findByEmail(email.toLowerCase()) : null;
    const valid = account && password ? await verifyPassword(password, account.passwordHash) : false;
    if (!account || !valid || account.status !== 'active') {
      throw new BusinessError(403, 'Approval was refused', 'shift_approval_refused');
    }
    approverId = account.id;
  }
  ok(res, await service.addMovement(actorOf(req), idOf(req), movement, approverId));
}

export async function reverseMovement(req: Request, res: Response): Promise<void> {
  const { id, movementId } = req.params as unknown as { id: number; movementId: number };
  ok(res, await service.reverseMovement(actorOf(req), id, movementId));
}

export async function close(req: Request, res: Response): Promise<void> {
  ok(res, await service.closeShift(actorOf(req), idOf(req), req.body as { counted_syp: number; left_in_drawer_syp: number; counted_usd?: number; left_in_drawer_usd?: number }));
}

export async function setReason(req: Request, res: Response): Promise<void> {
  ok(res, await service.setReason(actorOf(req), idOf(req), req.body as { reason_code: ShiftReasonCode; note?: string }));
}

export async function review(req: Request, res: Response): Promise<void> {
  ok(res, await service.reviewShift(actorOf(req), idOf(req)));
}

export async function report(req: Request, res: Response): Promise<void> {
  ok(res, await service.getReport(actorOf(req), idOf(req)));
}

const filtersOf = (query: ShiftsQuery): service.ShiftsFilters => ({
  branchId: query.branch_id,
  cashierUserId: query.cashier_user_id,
  status: query.status,
  from: query.from,
  to: query.to,
  withDifference: query.with_difference,
  needsReview: query.needs_review,
});

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ShiftsQuery;
  const params = toPaginationParams(query);
  const { items, total } = await service.listShifts(actorOf(req), filtersOf(query), params.limit, params.offset);
  ok(res, paginated(items, total, params));
}

export async function summary(req: Request, res: Response): Promise<void> {
  ok(res, await service.shiftsSummary(actorOf(req), filtersOf(req.query as unknown as ShiftsQuery)));
}
