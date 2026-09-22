import type { Request, Response } from 'express';
import { created, ok } from '../../../core/http/response.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import * as unitsService from '../services/units.service.js';
import type { IdParams } from '../dtos/common.dto.js';
import type { CreateUnitBody, UpdateUnitBody } from '../dtos/units.dto.js';

export async function listUnits(_req: Request, res: Response): Promise<void> {
  ok(res, await unitsService.listUnits());
}

export async function createUnit(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  created(res, await unitsService.createUnit(actor, req.body as CreateUnitBody));
}

export async function updateUnit(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  ok(res, await unitsService.updateUnit(actor, id, req.body as UpdateUnitBody));
}
