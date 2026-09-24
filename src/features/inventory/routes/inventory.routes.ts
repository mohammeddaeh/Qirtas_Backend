import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import * as inventoryController from '../controllers/inventory.controller.js';
import {
  adjustmentBodySchema,
  adjustmentsFilterQuerySchema,
  documentItemsQuerySchema,
  branchScopeQuerySchema,
  inventorySettingsBodySchema,
  movementsFilterQuerySchema,
  receiptBodySchema,
  receiptsFilterQuerySchema,
  stockFilterQuerySchema,
  thresholdBodySchema,
} from '../dtos/stock.dto.js';
import {
  createSupplierBodySchema,
  suppliersFilterQuerySchema,
  updateSupplierBodySchema,
} from '../dtos/suppliers.dto.js';
import { returnBodySchema, returnsFilterQuerySchema } from '../dtos/returns.dto.js';
import {
  countBodySchema,
  countLineBodySchema,
  countsFilterQuerySchema,
  receiveTransferBodySchema,
  resolveTransferBodySchema,
  transferBodySchema,
  transfersFilterQuerySchema,
} from '../dtos/transfers.dto.js';

/**
 * Stock and suppliers — docs/rest_api.md §22.
 *
 * Every write names the branch it belongs to in its body or query, and the
 * services check the caller holds the key **at that branch** where the rule
 * depends on it (approving an adjustment). The route guard answers the
 * cheaper question first: does this account hold the key anywhere at all.
 */
export const inventoryRouter = Router();

const canView = requirePermission('inventory.view', {
  display: { ar: 'عرض المخزون', en: 'View Stock' },
});
const canReceive = requirePermission('inventory.receive', {
  display: { ar: 'استلام البضاعة', en: 'Receive Goods' },
});
const canAdjust = requirePermission('inventory.adjust', {
  display: { ar: 'تسجيل التلف والفقد', en: 'Record Damage & Loss' },
  sensitive: true,
});
const canApprove = requirePermission('inventory.approve', {
  display: { ar: 'اعتماد فروق المخزون', en: 'Approve Stock Differences' },
  sensitive: true,
});
const canViewSuppliers = requirePermission('suppliers.view', {
  display: { ar: 'عرض الموردين', en: 'View Suppliers' },
});
const canManageSuppliers = requirePermission('suppliers.manage', {
  display: { ar: 'إدارة الموردين', en: 'Manage Suppliers' },
});

const withId = validate(idParamsSchema, 'params');
const withReceiptsQuery = validate(paginationQuerySchema.merge(receiptsFilterQuerySchema), 'query');

// ── Suppliers ───────────────────────────────────────────────────────────────

inventoryRouter.get(
  '/suppliers',
  canViewSuppliers,
  validate(paginationQuerySchema.merge(suppliersFilterQuerySchema), 'query'),
  asyncHandler(inventoryController.listSuppliers),
);
inventoryRouter.get('/suppliers/:id', canViewSuppliers, withId, asyncHandler(inventoryController.getSupplier));
inventoryRouter.post(
  '/suppliers',
  canManageSuppliers,
  validate(createSupplierBodySchema, 'body'),
  asyncHandler(inventoryController.createSupplier),
);
inventoryRouter.patch(
  '/suppliers/:id',
  canManageSuppliers,
  withId,
  validate(updateSupplierBodySchema, 'body'),
  asyncHandler(inventoryController.updateSupplier),
);
inventoryRouter.post(
  '/suppliers/:id/archive',
  canManageSuppliers,
  withId,
  asyncHandler(inventoryController.archiveSupplier),
);
inventoryRouter.post(
  '/suppliers/:id/unarchive',
  canManageSuppliers,
  withId,
  asyncHandler(inventoryController.unarchiveSupplier),
);
inventoryRouter.delete(
  '/suppliers/:id',
  canManageSuppliers,
  withId,
  asyncHandler(inventoryController.deleteSupplier),
);

// ── Receiving ───────────────────────────────────────────────────────────────

inventoryRouter.post(
  '/inventory/receipts',
  canReceive,
  validate(receiptBodySchema, 'body'),
  asyncHandler(inventoryController.createReceipt),
);
inventoryRouter.get(
  '/inventory/receipts',
  canView,
  withReceiptsQuery,
  asyncHandler(inventoryController.listReceipts),
);
inventoryRouter.get('/inventory/receipts/:id', canView, withId, asyncHandler(inventoryController.getReceipt));

// ── Returning to the supplier (inventory_suppliers.md §٧) ──────────────
// Sending goods back is the other half of receiving them, and the same hands
// do it — `inventory.receive`. It is not an adjustment: nothing was lost, the
// supplier took it back, and only that belongs in what we owe him.
inventoryRouter.get(
  '/inventory/receipts/:id/returnable',
  canReceive,
  withId,
  asyncHandler(inventoryController.listReturnable),
);
inventoryRouter.post(
  '/inventory/returns',
  canReceive,
  validate(returnBodySchema, 'body'),
  asyncHandler(inventoryController.createReturn),
);
inventoryRouter.get(
  '/inventory/returns',
  canView,
  validate(paginationQuerySchema.merge(returnsFilterQuerySchema), 'query'),
  asyncHandler(inventoryController.listReturns),
);
inventoryRouter.get('/inventory/returns/:id', canView, withId, asyncHandler(inventoryController.getReturn));

// ── Stock ───────────────────────────────────────────────────────────────────

// What a receiving or damage line may name. Reading it is reading stock, so
// `inventory.view` — the write it feeds is guarded where the write happens.
inventoryRouter.get(
  '/inventory/document-items',
  canView,
  validate(documentItemsQuerySchema, 'query'),
  asyncHandler(inventoryController.searchDocumentItems),
);
inventoryRouter.get(
  '/inventory/stock',
  canView,
  validate(paginationQuerySchema.merge(stockFilterQuerySchema), 'query'),
  asyncHandler(inventoryController.listStock),
);
inventoryRouter.get(
  '/inventory/movements',
  canView,
  validate(paginationQuerySchema.merge(movementsFilterQuerySchema), 'query'),
  asyncHandler(inventoryController.listMovements),
);
inventoryRouter.get(
  '/inventory/signals',
  canView,
  validate(branchScopeQuerySchema, 'query'),
  asyncHandler(inventoryController.getSignals),
);
inventoryRouter.get(
  '/inventory/variants/:id/threshold-suggestion',
  canView,
  withId,
  validate(branchScopeQuerySchema, 'query'),
  asyncHandler(inventoryController.suggestThreshold),
);
inventoryRouter.put(
  '/inventory/variants/:id/threshold',
  canReceive,
  withId,
  validate(thresholdBodySchema, 'body'),
  asyncHandler(inventoryController.setThreshold),
);
inventoryRouter.get('/inventory/settings', canView, asyncHandler(inventoryController.getSettings));
inventoryRouter.put(
  '/inventory/settings',
  canApprove,
  validate(inventorySettingsBodySchema, 'body'),
  asyncHandler(inventoryController.setSettings),
);

// ── Adjustments ─────────────────────────────────────────────────────────────

inventoryRouter.post(
  '/inventory/adjustments',
  canAdjust,
  validate(adjustmentBodySchema, 'body'),
  asyncHandler(inventoryController.createAdjustment),
);
inventoryRouter.get(
  '/inventory/adjustments',
  canView,
  validate(paginationQuerySchema.merge(adjustmentsFilterQuerySchema), 'query'),
  asyncHandler(inventoryController.listAdjustments),
);
inventoryRouter.get('/inventory/adjustments/:id', canView, withId, asyncHandler(inventoryController.getAdjustment));
inventoryRouter.post(
  '/inventory/adjustments/:id/approve',
  canApprove,
  withId,
  asyncHandler(inventoryController.approveAdjustment),
);
inventoryRouter.post(
  '/inventory/adjustments/:id/reject',
  canApprove,
  withId,
  asyncHandler(inventoryController.rejectAdjustment),
);

// ── Transfers (§٤) ──────────────────────────────────────────────────────────
// The scope is checked in the service, per step: the sending branch approves
// and ships, the receiving branch receives. A route guard cannot know which
// of the two this caller is.
const canTransfer = requirePermission('inventory.transfer', {
  display: { ar: 'نقل البضاعة بين الفروع', en: 'Transfer Stock Between Branches' },
});

inventoryRouter.post(
  '/inventory/transfers',
  canTransfer,
  validate(transferBodySchema, 'body'),
  asyncHandler(inventoryController.createTransfer),
);
inventoryRouter.get(
  '/inventory/transfers',
  canView,
  validate(paginationQuerySchema.merge(transfersFilterQuerySchema), 'query'),
  asyncHandler(inventoryController.listTransfers),
);
inventoryRouter.get('/inventory/transfers/:id', canView, withId, asyncHandler(inventoryController.getTransfer));
inventoryRouter.post(
  '/inventory/transfers/:id/approve',
  canTransfer,
  withId,
  asyncHandler(inventoryController.approveTransfer),
);
inventoryRouter.post(
  '/inventory/transfers/:id/reject',
  canTransfer,
  withId,
  asyncHandler(inventoryController.rejectTransfer),
);
inventoryRouter.post(
  '/inventory/transfers/:id/ship',
  canTransfer,
  withId,
  validate(receiveTransferBodySchema, 'body'),
  asyncHandler(inventoryController.shipTransfer),
);
inventoryRouter.post(
  '/inventory/transfers/:id/receive',
  canTransfer,
  withId,
  validate(receiveTransferBodySchema, 'body'),
  asyncHandler(inventoryController.receiveTransfer),
);
inventoryRouter.post(
  '/inventory/transfers/:id/resolve',
  canTransfer,
  withId,
  validate(resolveTransferBodySchema, 'body'),
  asyncHandler(inventoryController.resolveTransfer),
);
inventoryRouter.post(
  '/inventory/transfers/:id/close',
  canTransfer,
  withId,
  asyncHandler(inventoryController.closeTransfer),
);

// ── Stocktakes (§٥) ─────────────────────────────────────────────────────────
const canCount = requirePermission('inventory.count', {
  display: { ar: 'الجرد', en: 'Stocktaking' },
});

inventoryRouter.post(
  '/inventory/counts',
  canCount,
  validate(countBodySchema, 'body'),
  asyncHandler(inventoryController.openCount),
);
inventoryRouter.get(
  '/inventory/counts',
  canView,
  validate(paginationQuerySchema.merge(countsFilterQuerySchema), 'query'),
  asyncHandler(inventoryController.listCounts),
);
inventoryRouter.get('/inventory/counts/:id', canView, withId, asyncHandler(inventoryController.getCount));
inventoryRouter.post(
  '/inventory/counts/:id/lines',
  canCount,
  withId,
  validate(countLineBodySchema, 'body'),
  asyncHandler(inventoryController.recordCountLine),
);
inventoryRouter.post('/inventory/counts/:id/close', canCount, withId, asyncHandler(inventoryController.closeCount));
inventoryRouter.post(
  '/inventory/counts/:id/approve',
  canApprove,
  withId,
  asyncHandler(inventoryController.approveCount),
);
inventoryRouter.post('/inventory/counts/:id/reject', canApprove, withId, asyncHandler(inventoryController.rejectCount));
