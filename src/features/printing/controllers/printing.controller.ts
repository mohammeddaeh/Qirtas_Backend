import type { Request, Response } from 'express';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { created, ok } from '../../../core/http/response.js';
import type {
  BranchOptionsBody,
  CreateOptionBody,
  QuoteBody,
  RatesBody,
  SettingsBody,
  TiersBody,
  UpdateOptionBody,
} from '../dtos/printing.dto.js';
import * as service from '../services/printing.service.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const branchParam = (req: Request) => (req.params as unknown as { branchId: number }).branchId;

export async function offer(req: Request, res: Response): Promise<void> {
  ok(res, await service.offer((req.query as unknown as { branch_id: number }).branch_id));
}

export async function quote(req: Request, res: Response): Promise<void> {
  const b = req.body as QuoteBody;
  ok(
    res,
    await service.priceJob(b.branch_id, {
      pages: b.pages,
      copies: b.copies,
      paperSizeId: b.paper_size_id,
      colorModeId: b.color_mode_id,
      sidesId: b.sides_id,
      bindingId: b.binding_id,
      coverId: b.cover_id,
    }),
  );
}

export async function getConfig(req: Request, res: Response): Promise<void> {
  const branchId = (req.query as unknown as { branch_id?: number }).branch_id ?? null;
  ok(res, await service.getConfig(actorOf(req), branchId));
}

export async function createOption(req: Request, res: Response): Promise<void> {
  created(res, await service.createOption(actorOf(req), req.body as CreateOptionBody));
}

export async function updateOption(req: Request, res: Response): Promise<void> {
  const id = (req.params as unknown as { id: number }).id;
  ok(res, await service.updateOption(actorOf(req), id, req.body as UpdateOptionBody));
}

export async function setRates(req: Request, res: Response): Promise<void> {
  const b = req.body as RatesBody;
  ok(res, await service.setCentralRates(actorOf(req), b.page_rates, b.finishing_rates));
}

export async function setTiers(req: Request, res: Response): Promise<void> {
  ok(res, await service.setTiers(actorOf(req), (req.body as TiersBody).tiers));
}

export async function setSettings(req: Request, res: Response): Promise<void> {
  ok(res, await service.setSettings(actorOf(req), req.body as SettingsBody));
}

export async function setBranchOptions(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await service.setBranchOptions(
      actorOf(req),
      branchParam(req),
      (req.body as BranchOptionsBody).options,
    ),
  );
}

export async function setBranchRates(req: Request, res: Response): Promise<void> {
  const b = req.body as RatesBody;
  ok(
    res,
    await service.setBranchRates(actorOf(req), branchParam(req), b.page_rates, b.finishing_rates),
  );
}
