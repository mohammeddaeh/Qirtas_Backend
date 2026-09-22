import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { requireActorId, buildActorContext } from '../../../core/http/require-actor.js';
import * as ownershipsService from '../services/ownerships.service.js';
import type { CreateOwnershipBody, RevisePercentageBody } from '../dtos/ownerships.dto.js';

export async function list(req: Request, res: Response): Promise<void> {
  const { branch_scope } = req.query as unknown as { branch_scope?: number };
  ok(res, await ownershipsService.listActive(branch_scope));
}

export async function createOwnership(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const ownership = await ownershipsService.createOwnership(actor, req.body as CreateOwnershipBody);
  created(res, ownership);
}

export async function reviseOwnership(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  const { percentage } = req.body as RevisePercentageBody;
  ok(res, await ownershipsService.reviseOwnership(actor, id, percentage));
}

export async function endOwnership(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  await ownershipsService.endOwnership(actor, id);
  ok(res, null);
}
