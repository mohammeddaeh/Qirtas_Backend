import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import { requireActorId, buildActorContext } from '../../../core/http/require-actor.js';
import * as branchesService from '../services/branches.service.js';
import type { CreateBranchBody, UpdateBranchBody, BranchesFilterQuery } from '../dtos/branches.dto.js';

export async function listBranches(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { page: number; limit: number } & BranchesFilterQuery;
  const params = toPaginationParams(query);
  const result = await branchesService.listBranches(params, query);
  ok(res, result);
}

export async function getBranchById(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const branch = await branchesService.getBranchById(id);
  ok(res, branch);
}

export async function listBranchStaff(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const query = req.query as unknown as { page: number; limit: number };
  const result = await branchesService.listBranchStaff(id, toPaginationParams(query));
  ok(res, result);
}

export async function createBranch(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const body = req.body as CreateBranchBody;
  const branch = await branchesService.createBranch(actor, body);
  created(res, branch);
}

export async function updateBranch(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  const body = req.body as UpdateBranchBody;
  const branch = await branchesService.updateBranch(actor, id, body);
  ok(res, branch);
}
