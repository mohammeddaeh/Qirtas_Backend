import type { Request, Response } from 'express';
import { verifyPassword } from '../../../core/auth/services/password.service.js';
import { staffRealm } from '../../../core/auth/realm.js';
import { BusinessError } from '../../../core/http/api-error.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { created, ok } from '../../../core/http/response.js';
import { paginated, toPaginationParams } from '../../../core/pagination/pagination.js';
import type { ExpensesQuery } from '../dtos/expenses.dto.js';
import * as service from '../services/expenses.service.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idOf = (req: Request) => Number((req.params as { id: string }).id);
const userIdOf = (req: Request) => Number((req.params as { userId: string }).userId);

function dayAfter(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function listCategories(req: Request, res: Response): Promise<void> {
  ok(res, await service.listCategories((req.query as { include_inactive?: string }).include_inactive === 'true'));
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  created(res, await service.createCategory(actorOf(req), req.body as Parameters<typeof service.createCategory>[1]));
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  ok(res, await service.updateCategory(actorOf(req), idOf(req), req.body as Parameters<typeof service.updateCategory>[2]));
}

export async function list(req: Request, res: Response): Promise<void> {
  const q = req.query as unknown as ExpensesQuery;
  const params = toPaginationParams(q);
  const { items, total, summary } = await service.listExpenses(
    {
      branchId: q.branch_id,
      categoryId: q.category_id,
      employeeId: q.employee_id,
      from: q.from,
      to: q.to === undefined ? undefined : dayAfter(q.to),
    },
    params.page,
    params.limit,
  );
  ok(res, { ...paginated(items, total, params), summary });
}

export async function create(req: Request, res: Response): Promise<void> {
  const { approver_email: email, approver_password: password, ...input } = req.body as service.ExpenseInput & {
    approver_email?: string;
    approver_password?: string;
  };
  let approverId: number | null = null;
  if (email !== undefined || password !== undefined) {
    const account = email ? await staffRealm().store.findByEmail(email.toLowerCase()) : null;
    const valid = account && password ? await verifyPassword(password, account.passwordHash) : false;
    if (!account || !valid || account.status !== 'active') {
      throw new BusinessError(403, 'Approval was refused', 'shift_approval_refused');
    }
    approverId = account.id;
  }
  created(res, await service.createExpense(actorOf(req), input, approverId));
}

export async function getOne(req: Request, res: Response): Promise<void> {
  ok(res, await service.getExpense(idOf(req)));
}

export async function reverse(req: Request, res: Response): Promise<void> {
  ok(res, await service.reverseExpense(actorOf(req), idOf(req), (req.body as { reason: string }).reason));
}

export async function listRecurring(req: Request, res: Response): Promise<void> {
  ok(res, await service.listRecurring((req.query as { include_inactive?: string }).include_inactive === 'true'));
}

export async function createRecurring(req: Request, res: Response): Promise<void> {
  created(res, await service.createRecurring(actorOf(req), req.body as Parameters<typeof service.createRecurring>[1]));
}

export async function updateRecurring(req: Request, res: Response): Promise<void> {
  ok(res, await service.updateRecurring(actorOf(req), idOf(req), req.body as Parameters<typeof service.updateRecurring>[2]));
}

export async function listWages(req: Request, res: Response): Promise<void> {
  const q = req.query as unknown as { branch_id?: number };
  ok(res, await service.listWages(q.branch_id));
}

export async function wageHistory(req: Request, res: Response): Promise<void> {
  ok(res, await service.wageHistory(userIdOf(req)));
}

export async function setWage(req: Request, res: Response): Promise<void> {
  ok(res, await service.setWage(actorOf(req), userIdOf(req), req.body as Parameters<typeof service.setWage>[2]));
}

export async function endWage(req: Request, res: Response): Promise<void> {
  ok(res, await service.endWage(actorOf(req), userIdOf(req), (req.body as { ended_on?: string }).ended_on));
}
