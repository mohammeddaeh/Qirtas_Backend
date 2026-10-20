import type { Request, Response } from 'express';
import { verifyPassword } from '../../../core/auth/services/password.service.js';
import { staffRealm } from '../../../core/auth/realm.js';
import { BusinessError } from '../../../core/http/api-error.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { created, ok } from '../../../core/http/response.js';
import * as service from '../services/payables.service.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idOf = (req: Request) => Number((req.params as { id: string }).id);

export async function list(req: Request, res: Response): Promise<void> {
  const q = req.query as unknown as { search?: string; branch_id?: number };
  ok(res, await service.listPayables({ search: q.search, branchId: q.branch_id }));
}

export async function account(req: Request, res: Response): Promise<void> {
  const q = req.query as unknown as { branch_id?: number };
  ok(res, await service.getSupplierAccount(idOf(req), q.branch_id));
}

export async function invoice(req: Request, res: Response): Promise<void> {
  ok(res, await service.getInvoicePayState(idOf(req)));
}

export async function pay(req: Request, res: Response): Promise<void> {
  const { approver_email: email, approver_password: password, ...input } = req.body as service.PayInput & {
    approver_email?: string;
    approver_password?: string;
  };
  let approverId: number | null = null;
  if (email !== undefined || password !== undefined) {
    const found = email ? await staffRealm().store.findByEmail(email.toLowerCase()) : null;
    const valid = found && password ? await verifyPassword(password, found.passwordHash) : false;
    if (!found || !valid || found.status !== 'active') {
      throw new BusinessError(403, 'Approval was refused', 'shift_approval_refused');
    }
    approverId = found.id;
  }
  created(res, await service.pay(actorOf(req), input, approverId));
}

export async function reverse(req: Request, res: Response): Promise<void> {
  ok(res, await service.reversePayment(actorOf(req), idOf(req), (req.body as { reason: string }).reason));
}

export async function convert(req: Request, res: Response): Promise<void> {
  ok(res, await service.convertInvoice(actorOf(req), idOf(req), req.body as { rate: number; note?: string }));
}
