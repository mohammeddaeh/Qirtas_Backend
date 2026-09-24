import type { Request, Response } from 'express';
import { created, noContentOk, ok } from '../../../core/http/response.js';
import { requireCustomerId } from '../../../core/http/require-customer.js';
import type { DemandBody } from '../dtos/storefront.dto.js';
import * as demandService from '../services/demand.service.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import * as repository from '../repositories/storefront.repository.js';
import * as storefrontService from '../services/storefront.service.js';
import type { ViewerContext } from '../services/storefront.service.js';

/**
 * Who is looking, and from where.
 *
 * The branch and the coordinates come from the request — a guest has no
 * account to read them from. The wholesale approval does **not**: it is read
 * from the session's own customer row, because a flag the client could send
 * would be a discount anybody could ask for.
 */
async function viewerOf(req: Request): Promise<ViewerContext> {
  const query = req.query as unknown as { branch_id: number; lat?: number; lng?: number };
  const customerId = req.customer?.id ?? null;
  return {
    branchId: query.branch_id,
    customerId,
    lat: query.lat ?? null,
    lng: query.lng ?? null,
    isWholesale: customerId === null ? false : await repository.isWholesaleCustomer(customerId),
  };
}

export async function listProducts(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as {
    page: number;
    limit: number;
    category_id?: number;
    collection_id?: number;
    search?: string;
  };
  ok(res, await storefrontService.listProducts(await viewerOf(req), toPaginationParams(query), query));
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const id = (req.params as unknown as { id: number }).id;
  ok(res, await storefrontService.getProduct(await viewerOf(req), id));
}

export async function listCategories(_req: Request, res: Response): Promise<void> {
  ok(res, await storefrontService.listCategories());
}

export async function listCollections(_req: Request, res: Response): Promise<void> {
  ok(res, await storefrontService.listCollections());
}

// ── «أعلمني» و«اطلب توفيره بفرعي» (§٨) ──────────────────────────────────────

export async function recordDemand(req: Request, res: Response): Promise<void> {
  created(res, await demandService.recordDemand(requireCustomerId(req), req.body as DemandBody));
}

export async function cancelDemand(req: Request, res: Response): Promise<void> {
  await demandService.cancelDemand(requireCustomerId(req), (req.params as unknown as { id: number }).id);
  noContentOk(res);
}

export async function listMyDemand(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { branch_id: number };
  ok(res, await demandService.listMine(requireCustomerId(req), query.branch_id));
}

/** للمدير: ما ينتظره زبائن فرعه، مجمَّعاً — لا صفّاً لكل طلب. */
export async function listDemandSummary(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { branch_id: number };
  ok(res, await demandService.summariseDemand(query.branch_id));
}
