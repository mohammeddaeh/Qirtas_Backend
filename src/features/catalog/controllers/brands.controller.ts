import type { Request, Response } from 'express';
import { created, noContentOk, ok } from '../../../core/http/response.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import * as brandsService from '../services/brands.service.js';
import type { IdParams } from '../dtos/common.dto.js';
import type { BrandsFilterQuery, CreateBrandBody, UpdateBrandBody } from '../dtos/brands.dto.js';

export async function listBrands(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { page: number; limit: number } & BrandsFilterQuery;
  ok(res, await brandsService.listBrands(toPaginationParams(query), query));
}

export async function createBrand(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  created(res, await brandsService.createBrand(actor, req.body as CreateBrandBody));
}

export async function updateBrand(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  ok(res, await brandsService.updateBrand(actor, id, req.body as UpdateBrandBody));
}

export async function deleteBrand(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  await brandsService.deleteBrand(actor, id);
  noContentOk(res);
}

export async function archiveBrand(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  ok(res, await brandsService.archiveBrand(actor, id));
}

export async function unarchiveBrand(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  ok(res, await brandsService.unarchiveBrand(actor, id));
}
