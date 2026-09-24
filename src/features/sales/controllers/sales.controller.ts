import type { Request, Response } from 'express';
import { verifyPassword } from '../../../core/auth/services/password.service.js';
import { staffRealm } from '../../../core/auth/realm.js';
import { BusinessError } from '../../../core/http/api-error.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { paginated, toPaginationParams } from '../../../core/pagination/pagination.js';
import { created, ok } from '../../../core/http/response.js';
import type { DiscountBody, PayBody, SalesQuery } from '../dtos/sales.dto.js';
import * as service from '../services/sales.service.js';
import * as repo from '../repositories/sales.repository.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idOf = (req: Request) => (req.params as unknown as { id: number }).id;

export async function open(req: Request, res: Response): Promise<void> {
  created(res, await service.openSale(actorOf(req), req.body as { branch_id: number }));
}

export async function getOne(req: Request, res: Response): Promise<void> {
  ok(res, await service.getSale(idOf(req)));
}

export async function listOpen(req: Request, res: Response): Promise<void> {
  const { branch_id: branchId } = req.query as unknown as { branch_id: number };
  // سلّات **هذا الكاشير** وحده: سلّةُ زميلٍ تُقرأ هنا «نسيتُها» فتُلغى،
  // وصاحبها واقفٌ عند الصندوق الآخر.
  ok(res, await service.listOpenSales(branchId, requireActorId(req)));
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as SalesQuery;
  const params = toPaginationParams(query);
  const { rows, total } = await repo.findSales(
    { branchId: query.branch_id, cashierId: query.cashier_id, status: query.status },
    params.limit,
    (params.page - 1) * params.limit,
  );
  const items = await Promise.all(rows.map((row) => service.getSale(row.id)));
  ok(res, paginated(items, total, params));
}

export async function searchItems(req: Request, res: Response): Promise<void> {
  const q = req.query as unknown as { branch_id: number; search: string };
  ok(res, await service.searchItems(q.branch_id, q.search));
}

export async function addLine(req: Request, res: Response): Promise<void> {
  ok(res, await service.addLine(actorOf(req), idOf(req), req.body as { variant_id: number; qty: number }));
}

export async function setLineQty(req: Request, res: Response): Promise<void> {
  const { id, lineId } = req.params as unknown as { id: number; lineId: number };
  ok(res, await service.setLineQty(id, lineId, (req.body as { qty: number }).qty));
}

export async function removeLine(req: Request, res: Response): Promise<void> {
  const { id, lineId } = req.params as unknown as { id: number; lineId: number };
  ok(res, await service.removeLine(id, lineId));
}

export async function setHeld(req: Request, res: Response): Promise<void> {
  ok(res, await service.setHeld(idOf(req), (req.body as { held: boolean }).held));
}

export async function voidSale(req: Request, res: Response): Promise<void> {
  ok(res, await service.voidSale(actorOf(req), idOf(req)));
}

export async function checkDiscount(req: Request, res: Response): Promise<void> {
  const { percent } = req.query as unknown as { percent: number };
  ok(res, await service.checkDiscount(requireActorId(req), percent));
}

export async function setDiscount(req: Request, res: Response): Promise<void> {
  ok(res, await service.setDiscount(actorOf(req), idOf(req), req.body as DiscountBody));
}

/**
 * موافقة المدير **على نفس الجهاز** (§٦).
 *
 * يتحقّق من بريده وكلمة مروره ثم يضع الخصم باسمه — **ولا يُصدر جلسة**: توكنٌ
 * ثانٍ على جهاز الكاشير يبقى بعد انصراف المدير، وهو بالضبط ما تتفاداه
 * «الموافقة بنفس الجهاز».
 *
 * والرفض **واحد لكل الأسباب** (بريد مجهول أو كلمة خاطئة): تمييزهما يقول لمن
 * يجرّب أي البريدين موجود.
 */
export async function approveDiscount(req: Request, res: Response): Promise<void> {
  const body = req.body as { percent: number; email: string; password: string };
  const account = await staffRealm().store.findByEmail(body.email.toLowerCase());
  const valid = account ? await verifyPassword(body.password, account.passwordHash) : false;
  // **وحسابه فعّال**: كلمة مرورٍ صحيحة لحسابٍ معلَّق أو مرفوض كانت توافق على
  // خصم — الإيقاف يمنع الدخول ولا يمنع بصمةً على جهاز غيره. اكتُشف بالتجريب.
  if (!account || !valid || account.status !== 'active') {
    throw new BusinessError(403, 'Approval was refused', 'sale_approval_refused');
  }
  ok(
    res,
    await service.setDiscount(actorOf(req), idOf(req), {
      percent: body.percent,
      reason: (req.body as { reason?: string }).reason ?? '',
      approver_user_id: account.id,
    }),
  );
}

export async function pay(req: Request, res: Response): Promise<void> {
  const body = req.body as PayBody;
  ok(
    res,
    await service.paySale(actorOf(req), idOf(req), {
      payments: body.payments.map((p) => ({
        method: p.method,
        amountSyp: p.amount_syp,
        tenderedSyp: p.tendered_syp ?? null,
      })),
    }),
  );
}

export async function getCaps(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getCaps());
}

export async function setCap(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await service.setCap(
      actorOf(req),
      req.body as { role_id: number; max_discount_percent: number; can_approve: boolean },
    ),
  );
}

export async function getCustomerAccount(req: Request, res: Response): Promise<void> {
  ok(res, await service.getCustomerAccount(idOf(req)));
}

export async function setCreditLimit(req: Request, res: Response): Promise<void> {
  const { limit_syp: limit } = req.body as { limit_syp: number };
  ok(res, await service.setCreditLimit(actorOf(req), idOf(req), limit));
}

export async function adjustLedger(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await service.adjustCustomerLedger(
      actorOf(req),
      idOf(req),
      req.body as { amount_syp: number; note: string },
    ),
  );
}
