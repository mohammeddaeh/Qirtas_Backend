import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import * as branchesService from '../services/branches.service.js';
import type { CreateBranchBody, UpdateBranchBody } from '../dtos/branches.dto.js';

export async function listBranches(req: Request, res: Response): Promise<void> {
  const params = toPaginationParams(req.query as unknown as { page: number; limit: number });
  const result = await branchesService.listBranches(params);
  ok(res, result);
}

export async function getBranchById(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const branch = await branchesService.getBranchById(id);
  ok(res, branch);
}

export async function createBranch(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateBranchBody;
  const branch = await branchesService.createBranch(body);
  created(res, branch);
}

export async function updateBranch(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const body = req.body as UpdateBranchBody;
  const branch = await branchesService.updateBranch(id, body);
  ok(res, branch);
}
