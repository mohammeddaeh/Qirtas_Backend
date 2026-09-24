import type { Request, Response } from 'express';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import { created, noContentOk, ok } from '../../../core/http/response.js';
import type { IdParams } from '../dtos/common.dto.js';
import type {
  ApproveDraftBody,
  CreateDraftBody,
  DraftsFilterQuery,
  MergeDraftBody,
} from '../dtos/drafts.dto.js';
import * as draftsService from '../services/drafts.service.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idOf = (req: Request) => (req.params as unknown as IdParams).id;

export async function listDrafts(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { page: number; limit: number } & DraftsFilterQuery;
  ok(res, await draftsService.listDrafts(toPaginationParams(query), query));
}

export async function getDraft(req: Request, res: Response): Promise<void> {
  ok(res, await draftsService.getDraft(idOf(req)));
}

export async function createDraft(req: Request, res: Response): Promise<void> {
  created(res, await draftsService.createDraft(actorOf(req), req.body as CreateDraftBody));
}

export async function approveDraft(req: Request, res: Response): Promise<void> {
  ok(res, await draftsService.approveDraft(actorOf(req), idOf(req), req.body as ApproveDraftBody));
}

export async function mergeDraft(req: Request, res: Response): Promise<void> {
  ok(res, await draftsService.mergeDraft(actorOf(req), idOf(req), req.body as MergeDraftBody));
}

export async function deleteDraft(req: Request, res: Response): Promise<void> {
  await draftsService.deleteDraft(actorOf(req), idOf(req));
  noContentOk(res);
}
