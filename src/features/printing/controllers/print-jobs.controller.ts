import type { Request, Response } from 'express';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { requireCustomerId } from '../../../core/http/require-customer.js';
import { created, ok } from '../../../core/http/response.js';
import { paginated, toPaginationParams } from '../../../core/pagination/pagination.js';
import type {
  RecordQuery,
  AddLinkBody,
  CancelJobBody,
  CreateJobBody,
  DeferBody,
  MyJobsQuery,
  PickupLookupQuery,
  QueueCountsQuery,
  QueueQuery,
  QuoteJobBody,
  ReserveFileBody,
  StaffCancelBody,
  StageBody,
  UpdateJobBody,
} from '../dtos/print-jobs.dto.js';
import * as service from '../services/print-jobs.service.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const params = (req: Request) =>
  req.params as unknown as { id: number; fileId: number; linkId: number };

// ── الزبون ──────────────────────────────────────────────────────────────────

export async function create(req: Request, res: Response): Promise<void> {
  created(res, await service.createJob(requireCustomerId(req), req.body as CreateJobBody));
}

export async function update(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await service.updateDraft(requireCustomerId(req), params(req).id, req.body as UpdateJobBody),
  );
}

export async function listMine(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as MyJobsQuery;
  const p = toPaginationParams(query);
  const { items, total } = await service.listMine(
    requireCustomerId(req),
    query.status,
    p.limit,
    (p.page - 1) * p.limit,
  );
  ok(res, paginated(items, total, p));
}

export async function getMine(req: Request, res: Response): Promise<void> {
  ok(res, await service.getMine(requireCustomerId(req), params(req).id));
}

export async function reserveFile(req: Request, res: Response): Promise<void> {
  created(
    res,
    await service.reserveFile(requireCustomerId(req), params(req).id, req.body as ReserveFileBody),
  );
}

export async function completeFile(req: Request, res: Response): Promise<void> {
  const { id, fileId } = params(req);
  ok(res, await service.completeFile(requireCustomerId(req), id, fileId));
}

export async function deleteFile(req: Request, res: Response): Promise<void> {
  const { id, fileId } = params(req);
  ok(res, await service.deleteFile(requireCustomerId(req), id, fileId));
}

export async function myFileLink(req: Request, res: Response): Promise<void> {
  const { id, fileId } = params(req);
  ok(res, await service.myFileLink(requireCustomerId(req), id, fileId));
}

export async function addLink(req: Request, res: Response): Promise<void> {
  ok(res, await service.addLink(requireCustomerId(req), params(req).id, req.body as AddLinkBody));
}

export async function deleteLink(req: Request, res: Response): Promise<void> {
  const { id, linkId } = params(req);
  ok(res, await service.deleteLink(requireCustomerId(req), id, linkId));
}

export async function submit(req: Request, res: Response): Promise<void> {
  ok(res, await service.submitJob(requireCustomerId(req), params(req).id));
}

export async function cancelMine(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await service.cancelMine(
      requireCustomerId(req),
      params(req).id,
      (req.body as CancelJobBody).reason,
    ),
  );
}

// ── الموظف ──────────────────────────────────────────────────────────────────

export async function queueBranches(req: Request, res: Response): Promise<void> {
  ok(res, await service.queueBranches(actorOf(req)));
}

export async function handOver(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  ok(res, await service.handOver(actorOf(req), Number(id)));
}

function recordQueryOf(req: Request): service.RecordQuery {
  const q = req.query as unknown as RecordQuery;
  return {
    branchId: q.branch_id,
    q: q.q,
    source: q.source,
    state: q.state,
    from: q.from,
    to: q.to,
    customerId: q.customer_id,
  };
}

/** The record (9-ح-5) — every print, newest first. */
export async function listRecord(req: Request, res: Response): Promise<void> {
  const p = toPaginationParams(req.query as unknown as RecordQuery);
  const { items, total } = await service.listRecord(actorOf(req), recordQueryOf(req), p.limit, p.offset);
  ok(res, paginated(items, total, p));
}

export async function recordSummary(req: Request, res: Response): Promise<void> {
  ok(res, await service.recordSummary(actorOf(req), recordQueryOf(req)));
}

/** «اطبع مثله» — a new order with the old one's spec, at today's prices. */

export async function lookupForPickup(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as PickupLookupQuery;
  ok(res, await service.lookupForPickup(actorOf(req), query.branch_id, query.q, query.sale_id ?? null));
}

export async function queueCounts(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as QueueCountsQuery;
  ok(res, await service.queueCounts(actorOf(req), query.branch_id, { q: query.q, payment: query.payment }));
}

export async function listQueue(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as QueueQuery;
  const p = toPaginationParams(query);
  const { items, total } = await service.listQueue(
    actorOf(req),
    query.branch_id,
    query.status,
    p.limit,
    (p.page - 1) * p.limit,
    { q: query.q, payment: query.payment },
  );
  ok(res, paginated(items, total, p));
}

export async function getForStaff(req: Request, res: Response): Promise<void> {
  ok(res, await service.getForStaff(actorOf(req), params(req).id));
}

export async function staffFileLink(req: Request, res: Response): Promise<void> {
  const { id, fileId } = params(req);
  ok(res, await service.staffFileLink(actorOf(req), id, fileId));
}

export async function quote(req: Request, res: Response): Promise<void> {
  ok(res, await service.quoteJob(actorOf(req), params(req).id, req.body as QuoteJobBody));
}

export async function advance(req: Request, res: Response): Promise<void> {
  ok(res, await service.advanceJob(actorOf(req), params(req).id, (req.body as StageBody).status));
}

/** «سلِّم من الجاهز» — بدل بدء الطباعة. */
export async function fulfillFromReady(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await service.fulfillFromReady(
      actorOf(req),
      params(req).id,
      (req.body as { ready_copy_id: number }).ready_copy_id,
      (req.body as { copies?: number }).copies,
    ),
  );
}

export async function defer(req: Request, res: Response): Promise<void> {
  ok(res, await service.deferPayment(actorOf(req), params(req).id, (req.body as DeferBody).reason));
}

export async function cancelByStaff(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await service.cancelByStaff(actorOf(req), params(req).id, (req.body as StaffCancelBody).reason),
  );
}
