import type { Request, Response } from 'express';
import { created, noContentOk, ok } from '../../../core/http/response.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import * as categoriesService from '../services/categories.service.js';
import type { IdParams } from '../dtos/common.dto.js';
import type {
  CategoriesFilterQuery,
  CreateCategoryBody,
  ReplaceCategoryAttributesBody,
  UpdateCategoryBody,
} from '../dtos/categories.dto.js';

export async function listCategories(req: Request, res: Response): Promise<void> {
  ok(res, await categoriesService.listCategories(req.query as unknown as CategoriesFilterQuery));
}

export async function getCategory(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  ok(res, await categoriesService.getCategory(id));
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  created(res, await categoriesService.createCategory(actor, req.body as CreateCategoryBody));
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  ok(res, await categoriesService.updateCategory(actor, id, req.body as UpdateCategoryBody));
}

export async function replaceCategoryAttributes(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  const body = req.body as ReplaceCategoryAttributesBody;
  ok(res, await categoriesService.replaceCategoryAttributes(actor, id, body));
}

export async function deleteCategory(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  await categoriesService.deleteCategory(actor, id);
  noContentOk(res);
}

export async function archiveCategory(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  ok(res, await categoriesService.archiveCategory(actor, id));
}

export async function unarchiveCategory(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  ok(res, await categoriesService.unarchiveCategory(actor, id));
}
