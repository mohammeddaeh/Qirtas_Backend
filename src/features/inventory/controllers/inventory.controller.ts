import type { Request, Response } from 'express';
import { created, ok } from '../../../core/http/response.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import type { IdParams } from '../../catalog/dtos/common.dto.js';
import * as adjustmentsService from '../services/adjustments.service.js';
import * as receiptsService from '../services/receipts.service.js';
import type { ReturnBody, ReturnsFilterQuery } from '../dtos/returns.dto.js';
import * as returnsService from '../services/returns.service.js';
import * as stockService from '../services/stock.service.js';
import * as suppliersService from '../services/suppliers.service.js';
import * as transfersService from '../services/transfers.service.js';
import * as countsService from '../services/counts.service.js';
import type {
  AdjustmentBody,
  AdjustmentsFilterQuery,
  DocumentItemsQuery,
  InventorySettingsBody,
  MovementsFilterQuery,
  ReceiptBody,
  StockFilterQuery,
  ThresholdBody,
} from '../dtos/stock.dto.js';
import type { CreateSupplierBody, SuppliersFilterQuery, UpdateSupplierBody } from '../dtos/suppliers.dto.js';
import type { CountBody, CountLineBody, ReceiveTransferBody, TransferBody } from '../dtos/transfers.dto.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idOf = (req: Request) => (req.params as unknown as IdParams).id;
const pageOf = (req: Request) => toPaginationParams(req.query as unknown as { page: number; limit: number });

// ── Suppliers ───────────────────────────────────────────────────────────────

export async function listSuppliers(req: Request, res: Response): Promise<void> {
  ok(res, await suppliersService.listSuppliers(pageOf(req), req.query as unknown as SuppliersFilterQuery));
}

export async function getSupplier(req: Request, res: Response): Promise<void> {
  ok(res, await suppliersService.getSupplier(idOf(req)));
}

export async function createSupplier(req: Request, res: Response): Promise<void> {
  created(res, await suppliersService.createSupplier(actorOf(req), req.body as CreateSupplierBody));
}

export async function updateSupplier(req: Request, res: Response): Promise<void> {
  ok(res, await suppliersService.updateSupplier(actorOf(req), idOf(req), req.body as UpdateSupplierBody));
}

export async function archiveSupplier(req: Request, res: Response): Promise<void> {
  ok(res, await suppliersService.setSupplierArchived(actorOf(req), idOf(req), true));
}

export async function unarchiveSupplier(req: Request, res: Response): Promise<void> {
  ok(res, await suppliersService.setSupplierArchived(actorOf(req), idOf(req), false));
}

export async function deleteSupplier(req: Request, res: Response): Promise<void> {
  await suppliersService.deleteSupplier(actorOf(req), idOf(req));
  ok(res, null);
}

// ── Receiving ───────────────────────────────────────────────────────────────

export async function createReceipt(req: Request, res: Response): Promise<void> {
  created(res, await receiptsService.createReceipt(actorOf(req), req.body as ReceiptBody));
}

export async function listReceipts(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { branch_id?: number; supplier_id?: number };
  ok(res, await receiptsService.listReceipts(pageOf(req), query));
}

export async function getReceipt(req: Request, res: Response): Promise<void> {
  ok(res, await receiptsService.getReceipt(idOf(req)));
}

// ── Returning to the supplier ───────────────────────────────────

export async function listReturnable(req: Request, res: Response): Promise<void> {
  ok(res, await returnsService.listReturnable(idOf(req)));
}

export async function createReturn(req: Request, res: Response): Promise<void> {
  created(res, await returnsService.createReturn(actorOf(req), req.body as ReturnBody));
}

export async function listReturns(req: Request, res: Response): Promise<void> {
  ok(res, await returnsService.listReturns(pageOf(req), req.query as unknown as ReturnsFilterQuery));
}

export async function getReturn(req: Request, res: Response): Promise<void> {
  ok(res, await returnsService.getReturn(idOf(req)));
}

// ── Stock ───────────────────────────────────────────────────────────────────

export async function searchDocumentItems(req: Request, res: Response): Promise<void> {
  ok(res, await stockService.searchDocumentItems(req.query as unknown as DocumentItemsQuery));
}

export async function listStock(req: Request, res: Response): Promise<void> {
  ok(res, await stockService.listStock(pageOf(req), req.query as unknown as StockFilterQuery));
}

export async function listMovements(req: Request, res: Response): Promise<void> {
  ok(res, await stockService.listMovements(pageOf(req), req.query as unknown as MovementsFilterQuery));
}

export async function setThreshold(req: Request, res: Response): Promise<void> {
  ok(res, await stockService.setReorderThreshold(actorOf(req), idOf(req), req.body as ThresholdBody));
}

export async function suggestThreshold(req: Request, res: Response): Promise<void> {
  const { branch_id } = req.query as unknown as { branch_id: number };
  ok(res, await stockService.suggestReorderThreshold(branch_id, idOf(req)));
}

export async function getSignals(req: Request, res: Response): Promise<void> {
  const { branch_id } = req.query as unknown as { branch_id: number };
  ok(res, await stockService.getSignals(branch_id));
}

export async function getSettings(_req: Request, res: Response): Promise<void> {
  ok(res, await stockService.getSettings());
}

export async function setSettings(req: Request, res: Response): Promise<void> {
  ok(res, await stockService.setSettings(actorOf(req), req.body as InventorySettingsBody));
}

// ── Adjustments ─────────────────────────────────────────────────────────────

export async function createAdjustment(req: Request, res: Response): Promise<void> {
  created(res, await adjustmentsService.createAdjustment(actorOf(req), req.body as AdjustmentBody));
}

export async function listAdjustments(req: Request, res: Response): Promise<void> {
  ok(res, await adjustmentsService.listAdjustments(pageOf(req), req.query as unknown as AdjustmentsFilterQuery));
}

export async function getAdjustment(req: Request, res: Response): Promise<void> {
  ok(res, await adjustmentsService.getAdjustment(idOf(req)));
}

export async function approveAdjustment(req: Request, res: Response): Promise<void> {
  ok(res, await adjustmentsService.decideAdjustment(actorOf(req), idOf(req), true));
}

export async function rejectAdjustment(req: Request, res: Response): Promise<void> {
  ok(res, await adjustmentsService.decideAdjustment(actorOf(req), idOf(req), false));
}

// ── Transfers ───────────────────────────────────────────────────────────────

export async function createTransfer(req: Request, res: Response): Promise<void> {
  created(res, await transfersService.createTransfer(actorOf(req), req.body as TransferBody));
}

export async function listTransfers(req: Request, res: Response): Promise<void> {
  ok(res, await transfersService.listTransfers(pageOf(req), req.query as never));
}

export async function getTransfer(req: Request, res: Response): Promise<void> {
  ok(res, await transfersService.getTransfer(idOf(req)));
}

export async function approveTransfer(req: Request, res: Response): Promise<void> {
  ok(res, await transfersService.decideTransfer(actorOf(req), idOf(req), true));
}

export async function rejectTransfer(req: Request, res: Response): Promise<void> {
  ok(res, await transfersService.decideTransfer(actorOf(req), idOf(req), false));
}

export async function shipTransfer(req: Request, res: Response): Promise<void> {
  ok(res, await transfersService.shipTransfer(actorOf(req), idOf(req), req.body as ReceiveTransferBody));
}

export async function receiveTransfer(req: Request, res: Response): Promise<void> {
  ok(res, await transfersService.receiveTransfer(actorOf(req), idOf(req), req.body as ReceiveTransferBody));
}

export async function resolveTransfer(req: Request, res: Response): Promise<void> {
  const body = req.body as { resolution: 'loss' | 'returned'; note?: string | null };
  ok(res, await transfersService.resolveTransfer(actorOf(req), idOf(req), body));
}

export async function closeTransfer(req: Request, res: Response): Promise<void> {
  ok(res, await transfersService.closeTransfer(actorOf(req), idOf(req)));
}

// ── Counts ──────────────────────────────────────────────────────────────────

export async function openCount(req: Request, res: Response): Promise<void> {
  created(res, await countsService.openCount(actorOf(req), req.body as CountBody));
}

export async function listCounts(req: Request, res: Response): Promise<void> {
  ok(res, await countsService.listCounts(pageOf(req), req.query as never));
}

export async function getCount(req: Request, res: Response): Promise<void> {
  ok(res, await countsService.getCount(idOf(req)));
}

export async function recordCountLine(req: Request, res: Response): Promise<void> {
  ok(res, await countsService.recordCountLine(actorOf(req), idOf(req), req.body as CountLineBody));
}

export async function closeCount(req: Request, res: Response): Promise<void> {
  ok(res, await countsService.closeCount(actorOf(req), idOf(req)));
}

export async function approveCount(req: Request, res: Response): Promise<void> {
  ok(res, await countsService.decideCount(actorOf(req), idOf(req), true));
}

export async function rejectCount(req: Request, res: Response): Promise<void> {
  ok(res, await countsService.decideCount(actorOf(req), idOf(req), false));
}
