import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import * as ownershipsService from '../services/ownerships.service.js';
import type { CreateOwnershipBody } from '../dtos/ownerships.dto.js';

export async function listByScope(req: Request, res: Response): Promise<void> {
  const { branch_scope } = req.query as unknown as { branch_scope?: number };
  const result = await ownershipsService.listActiveByScope(branch_scope ?? null);
  ok(res, result);
}

export async function createOwnership(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateOwnershipBody;
  const ownership = await ownershipsService.createOwnership(body);
  created(res, ownership);
}
