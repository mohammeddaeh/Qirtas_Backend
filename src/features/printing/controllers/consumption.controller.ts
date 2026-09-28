import type { Request, Response } from 'express';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { ok } from '../../../core/http/response.js';
import type { InstallBody, RulesBody } from '../dtos/consumption.dto.js';
import * as service from '../services/consumption.service.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));

export async function getRules(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getRules());
}

export async function setRules(req: Request, res: Response): Promise<void> {
  ok(res, await service.setRules(actorOf(req), (req.body as RulesBody).rules));
}

export async function listConsumables(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await service.listConsumables(
      actorOf(req),
      (req.query as unknown as { branch_id: number }).branch_id,
    ),
  );
}

export async function install(req: Request, res: Response): Promise<void> {
  const variantId = (req.params as unknown as { variantId: number }).variantId;
  ok(res, await service.installConsumable(actorOf(req), variantId, req.body as InstallBody));
}

export async function searchMaterials(req: Request, res: Response): Promise<void> {
  ok(res, await service.searchMaterials((req.query as unknown as { search: string }).search));
}
