import type { Request, Response } from 'express';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { created, ok } from '../../../core/http/response.js';
import type {
  BranchOptionsBody,
  CounterSaleBody,
  ReadyCopiesQuery,
  ReadySaleBody,
  ReadyWriteOffBody,
  CreateOptionBody,
  QuoteBody,
  RatesBody,
  SettingsBody,
  TiersBody,
  UpdateOptionBody,
} from '../dtos/printing.dto.js';
import * as service from '../services/printing.service.js';
import * as jobs from '../services/print-jobs.service.js';
import * as ready from '../services/print-ready.js';

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

/** بيع طباعة مباشر بالصندوق (9-و) — يُسعَّر ويُحفظ مفتوحاً حتى يضيفه الكاشير لسلّته. */
/** Now an order (9-ح-1): `{id, kind: 'print_job'}` — the till adds it by that kind. */
export async function createCounterSale(req: Request, res: Response): Promise<void> {
  const b = req.body as CounterSaleBody;
  created(
    res,
    await jobs.createCounterJob(actorOf(req), {
      branchId: b.branch_id,
      spec: {
        paperSizeId: b.paper_size_id,
        colorModeId: b.color_mode_id,
        sidesId: b.sides_id,
        bindingId: b.binding_id,
        coverId: b.cover_id,
      },
      pages: b.pages,
      copies: b.copies,
      label: b.label ?? null,
      customerId: b.customer_id ?? null,
      contactName: b.walk_in ? null : (b.contact_name ?? null),
      contactPhone: b.walk_in ? null : (b.contact_phone ?? null),
    }),
  );
}

export async function contacts(req: Request, res: Response): Promise<void> {
  ok(res, await jobs.findContacts((req.query as { q: string }).q));
}

/** The ready shelf of a branch — with what it is worth now. */
export async function listReadyCopies(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ReadyCopiesQuery;
  const [items, shelf, staleDays] = await Promise.all([
    ready.listReadyCopies({
      branchId: query.branch_id,
      search: query.search,
      includeClosed: query.include_closed,
    }),
    ready.shelfSummary(query.branch_id),
    ready.readyStaleDays(),
  ]);
  // When a copy counts as old (9-ح-3) — with the shelf, since the cashier who
  // reads it holds no printing-settings key.
  ok(res, { items, shelf: { ...shelf, stale_days: staleDays } });
}

/** A ready copy priced for the basket — added with `POST /sales/:id/services {kind: 'print_ready'}`. */
export async function createReadySale(req: Request, res: Response): Promise<void> {
  created(
    res,
    await ready.createReadySale(requireActorId(req), Number(req.params.id), req.body as ReadySaleBody),
  );
}

export async function writeOffReadyCopies(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await ready.writeOffReadyCopies(
      requireActorId(req),
      Number(req.params.id),
      req.body as ReadyWriteOffBody,
    ),
  );
}
