import type { Request, Response } from 'express';
import { ok } from '../../../core/http/response.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import * as pricingService from '../services/pricing.service.js';
import type { IdParams } from '../dtos/common.dto.js';
import type { BranchPriceBody, BulkPriceBody, CategoryPricingRulesBody, CentralPriceBody } from '../dtos/pricing.dto.js';
import * as categoriesService from '../services/categories.service.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idOf = (req: Request) => (req.params as unknown as IdParams).id;
const branchVariantOf = (req: Request) => req.params as unknown as { branchId: number; variantId: number };
const branchOfQuery = (req: Request) => (req.query as unknown as { branch_id?: number }).branch_id ?? null;

export async function getSettings(_req: Request, res: Response): Promise<void> {
  ok(res, await pricingService.getSettings());
}

export async function setExchangeRate(req: Request, res: Response): Promise<void> {
  const { usd_to_syp } = req.body as { usd_to_syp: number };
  ok(res, await pricingService.setExchangeRate(actorOf(req), usd_to_syp));
}

export async function setRounding(req: Request, res: Response): Promise<void> {
  const { bands } = req.body as { bands: { below: number | null; step: number }[] };
  ok(res, await pricingService.setRoundingBands(actorOf(req), bands));
}

export async function getProductPricing(req: Request, res: Response): Promise<void> {
  ok(res, await pricingService.getProductPricing(actorOf(req), idOf(req), branchOfQuery(req)));
}

export async function setCentralPrice(req: Request, res: Response): Promise<void> {
  ok(res, await pricingService.setCentralPrice(actorOf(req), idOf(req), req.body as CentralPriceBody));
}

export async function setBranchPrice(req: Request, res: Response): Promise<void> {
  const { branchId, variantId } = branchVariantOf(req);
  ok(res, await pricingService.setBranchPrice(actorOf(req), branchId, variantId, req.body as BranchPriceBody));
}

export async function clearBranchPrice(req: Request, res: Response): Promise<void> {
  const { branchId, variantId } = branchVariantOf(req);
  ok(res, await pricingService.clearBranchPrice(actorOf(req), branchId, variantId));
}

export async function setListing(req: Request, res: Response): Promise<void> {
  const { branchId, variantId } = branchVariantOf(req);
  const { is_listed } = req.body as { is_listed: boolean };
  ok(res, await pricingService.setListing(actorOf(req), branchId, variantId, is_listed));
}

export async function getPriceHistory(req: Request, res: Response): Promise<void> {
  ok(res, await pricingService.getPriceHistory(idOf(req)));
}

export async function getWorklist(req: Request, res: Response): Promise<void> {
  ok(res, await pricingService.getWorklist(branchOfQuery(req)));
}

export async function previewBulk(req: Request, res: Response): Promise<void> {
  ok(res, await pricingService.previewBulk(req.body as BulkPriceBody));
}

export async function applyBulk(req: Request, res: Response): Promise<void> {
  ok(res, await pricingService.applyBulk(actorOf(req), req.body as BulkPriceBody));
}

/** Answers with the category detail — the rules are shown there, beside what they apply to. */
export async function setCategoryRules(req: Request, res: Response): Promise<void> {
  await pricingService.setCategoryRules(actorOf(req), idOf(req), req.body as CategoryPricingRulesBody);
  ok(res, await categoriesService.getCategory(idOf(req)));
}

export async function setProductBand(req: Request, res: Response): Promise<void> {
  const { price_band_percent } = req.body as { price_band_percent: number | null };
  ok(res, await pricingService.setProductBand(actorOf(req), idOf(req), price_band_percent));
}
