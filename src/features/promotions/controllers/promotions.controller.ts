import type { Request, Response } from 'express';
import { paginated, toPaginationParams } from '../../../core/pagination/pagination.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { created, noContentOk, ok } from '../../../core/http/response.js';
import type { PreviewBody, PromotionBody, PromotionsQuery } from '../dtos/promotions.dto.js';
import * as service from '../services/promotions.service.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as PromotionsQuery;
  const params = toPaginationParams(query);
  const { items, total } = await service.listPromotions(
    {
      search: query.search,
      branchId: query.branch_id,
      kind: query.kind,
      status: query.status,
      archived: query.archived,
    },
    params.limit,
    (params.page - 1) * params.limit,
  );
  ok(res, paginated(items, total, params));
}

export async function getOne(req: Request, res: Response): Promise<void> {
  ok(res, await service.getPromotion((req.params as unknown as { id: number }).id));
}

export async function create(req: Request, res: Response): Promise<void> {
  created(res, await service.createPromotion(actorOf(req), req.body as PromotionBody));
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = (req.params as unknown as { id: number }).id;
  ok(res, await service.updatePromotionById(actorOf(req), id, req.body as PromotionBody));
}

export async function setArchived(req: Request, res: Response): Promise<void> {
  const id = (req.params as unknown as { id: number }).id;
  const { archived } = req.body as { archived: boolean };
  ok(res, await service.archivePromotion(actorOf(req), id, archived));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.removePromotion(actorOf(req), (req.params as unknown as { id: number }).id);
  noContentOk(res);
}

export async function getCaps(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getCaps());
}

export async function setCap(req: Request, res: Response): Promise<void> {
  const body = req.body as { branch_id: number; max_discount_percent: number };
  ok(res, await service.setCap(actorOf(req), body.branch_id, body.max_discount_percent));
}

export async function preview(req: Request, res: Response): Promise<void> {
  ok(res, await service.previewBasket(req.body as PreviewBody));
}

export async function signals(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getSignals());
}
