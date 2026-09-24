import type { Request, Response } from 'express';
import { NotFoundError } from '../../../core/http/api-error.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { requireCustomerId } from '../../../core/http/require-customer.js';
import { paginated, toPaginationParams } from '../../../core/pagination/pagination.js';
import { created, ok } from '../../../core/http/response.js';
import type {
  CartItemBody,
  CartQtyBody,
  CheckoutBody,
  MyOrdersQuery,
  OrdersQuery,
} from '../dtos/orders.dto.js';
import * as service from '../services/orders.service.js';

const idOf = (req: Request) => (req.params as unknown as { id: number }).id;
const branchOf = (req: Request) => (req.query as unknown as { branch_id: number }).branch_id;

// ── السلّة (الزبون) ─────────────────────────────────────────────────────────

export async function getCart(req: Request, res: Response): Promise<void> {
  ok(res, await service.getCart(requireCustomerId(req), branchOf(req)));
}

export async function addToCart(req: Request, res: Response): Promise<void> {
  const body = req.body as CartItemBody;
  ok(res, await service.addToCart(requireCustomerId(req), branchOf(req), body));
}

export async function setCartQty(req: Request, res: Response): Promise<void> {
  const body = req.body as CartQtyBody;
  ok(res, await service.setCartQty(requireCustomerId(req), branchOf(req), body));
}

export async function removeFromCart(req: Request, res: Response): Promise<void> {
  const { variantId } = req.params as unknown as { variantId: string };
  ok(res, await service.removeFromCart(requireCustomerId(req), branchOf(req), Number(variantId)));
}

export async function checkout(req: Request, res: Response): Promise<void> {
  const body = req.body as CheckoutBody;
  created(res, await service.checkout(requireCustomerId(req), body.branch_id, { note: body.note }));
}

// ── طلباتي (الزبون) ─────────────────────────────────────────────────────────

export async function listMyOrders(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as MyOrdersQuery;
  const params = toPaginationParams(query);
  const { items, total } = await service.listOrders(
    { customerId: requireCustomerId(req), status: query.status },
    params.limit,
    (params.page - 1) * params.limit,
  );
  ok(res, paginated(items, total, params));
}

export async function getMyOrder(req: Request, res: Response): Promise<void> {
  const order = await service.getOrder(idOf(req));
  // طلبُ غيره **غير موجود** لا «ممنوع»: «ممنوع» تؤكّد أن الرقم صحيح، فيُجرَّب
  // الذي يليه.
  if (order.customer_id !== requireCustomerId(req)) throw new NotFoundError('Order not found');
  ok(res, order);
}

export async function cancelMyOrder(req: Request, res: Response): Promise<void> {
  const { reason } = req.body as { reason?: string | null };
  ok(
    res,
    await service.cancelOrder(idOf(req), { reason, customerId: requireCustomerId(req) }),
  );
}

// ── الطابور (الموظف) ────────────────────────────────────────────────────────

export async function listOrders(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as OrdersQuery;
  const params = toPaginationParams(query);
  const { items, total } = await service.listOrders(
    { branchId: query.branch_id, customerId: query.customer_id, status: query.status },
    params.limit,
    (params.page - 1) * params.limit,
  );
  ok(res, paginated(items, total, params));
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  ok(res, await service.getOrder(idOf(req)));
}

export async function startPickup(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  ok(res, await service.startPickup(actor, idOf(req)));
}

export async function cancelOrder(req: Request, res: Response): Promise<void> {
  const { reason } = req.body as { reason?: string | null };
  ok(res, await service.cancelOrder(idOf(req), { reason, userId: requireActorId(req) }));
}
