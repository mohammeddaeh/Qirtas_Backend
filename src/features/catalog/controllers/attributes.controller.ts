import type { Request, Response } from 'express';
import { created, noContentOk, ok } from '../../../core/http/response.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import * as attributesService from '../services/attributes.service.js';
import type { IdParams } from '../dtos/common.dto.js';
import type {
  CreateAttributeTypeBody,
  CreateAttributeValueBody,
  UpdateAttributeTypeBody,
  UpdateAttributeValueBody,
} from '../dtos/attributes.dto.js';

export async function listAttributeTypes(_req: Request, res: Response): Promise<void> {
  ok(res, await attributesService.listAttributeTypes());
}

export async function createAttributeType(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  created(
    res,
    await attributesService.createAttributeType(actor, req.body as CreateAttributeTypeBody),
  );
}

export async function updateAttributeType(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  ok(
    res,
    await attributesService.updateAttributeType(actor, id, req.body as UpdateAttributeTypeBody),
  );
}

export async function deleteAttributeType(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  await attributesService.deleteAttributeType(actor, id);
  noContentOk(res);
}

export async function createAttributeValue(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  created(
    res,
    await attributesService.createAttributeValue(actor, id, req.body as CreateAttributeValueBody),
  );
}

export async function updateAttributeValue(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  ok(
    res,
    await attributesService.updateAttributeValue(actor, id, req.body as UpdateAttributeValueBody),
  );
}

export async function deleteAttributeValue(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as IdParams;
  await attributesService.deleteAttributeValue(actor, id);
  noContentOk(res);
}
