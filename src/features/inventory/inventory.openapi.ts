import { z } from 'zod';
import { registry, successEnvelope, paginatedSchema, commonErrorResponses } from '../../core/openapi/registry.js';
import { idParamsSchema } from '../catalog/dtos/common.dto.js';
import {
  adjustmentBodySchema,
  adjustmentsFilterQuerySchema,
  branchScopeQuerySchema,
  inventorySettingsBodySchema,
  movementsFilterQuerySchema,
  receiptBodySchema,
  receiptsFilterQuerySchema,
  stockFilterQuerySchema,
  thresholdBodySchema,
} from './dtos/stock.dto.js';
import { returnBodySchema, returnsFilterQuerySchema } from './dtos/returns.dto.js';
import { createSupplierBodySchema, supplierResponseSchema, updateSupplierBodySchema } from './dtos/suppliers.dto.js';
import {
  countBodySchema,
  countLineBodySchema,
  countsFilterQuerySchema,
  receiveTransferBodySchema,
  resolveTransferBodySchema,
  transferBodySchema,
  transfersFilterQuerySchema,
} from './dtos/transfers.dto.js';

/**
 * Stock and suppliers in the generated docs — the shapes themselves are
 * written out in `docs/rest_api.md` §22, so the bodies here are the schemas
 * that already validate the requests and a passthrough object for responses
 * that have no zod twin.
 */

const tags = ['Inventory'];
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { 'application/json': { schema } } });
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  ...json(successEnvelope(schema)),
});
const shape = z.object({}).passthrough();
const params = { params: idParamsSchema };
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: json(schema) });

function route(
  method: 'get' | 'post' | 'patch' | 'put' | 'delete',
  path: string,
  summary: string,
  key: string,
  response: ReturnType<typeof ok>,
  request: Record<string, unknown> = {},
  status?: number,
): void {
  registry.registerPath({
    method,
    path: `/api/v1${path}`,
    tags,
    summary,
    description: `Requires \`${key}\`. Response shape: rest_api.md §22.`,
    request,
    responses: { [status ?? (method === 'post' ? 201 : 200)]: response, ...commonErrorResponses },
  });
}

// ── Suppliers ───────────────────────────────────────────────────────────────
route('get', '/suppliers', 'List suppliers', 'suppliers.view', ok('Suppliers', paginatedSchema(supplierResponseSchema)));
route('get', '/suppliers/{id}', 'One supplier', 'suppliers.view', ok('Supplier', supplierResponseSchema), params);
route('post', '/suppliers', 'Add a supplier', 'suppliers.manage', ok('Created', supplierResponseSchema), body(createSupplierBodySchema));
route('patch', '/suppliers/{id}', 'Edit a supplier', 'suppliers.manage', ok('Updated', supplierResponseSchema), { ...params, ...body(updateSupplierBodySchema) });
route('post', '/suppliers/{id}/archive', 'Archive a supplier', 'suppliers.manage', ok('Archived', supplierResponseSchema), params, 200);
route('post', '/suppliers/{id}/unarchive', 'Restore a supplier', 'suppliers.manage', ok('Restored', supplierResponseSchema), params, 200);
route('delete', '/suppliers/{id}', 'Delete a supplier that never appeared on an invoice', 'suppliers.manage', ok('Deleted', z.null()), params);

// ── Receiving ───────────────────────────────────────────────────────────────
route('post', '/inventory/receipts', 'Receive goods on a purchase invoice (posts its movements)', 'inventory.receive', ok('Created', shape), body(receiptBodySchema));
route('get', '/inventory/receipts', 'List purchase invoices', 'inventory.view', ok('Receipts', paginatedSchema(shape)), { query: receiptsFilterQuerySchema });
route('get', '/inventory/receipts/{id}', 'One purchase invoice with its lines', 'inventory.view', ok('Receipt', shape), params);

// ── Stock ───────────────────────────────────────────────────────────────────
route('get', '/inventory/stock', 'Balances at one branch', 'inventory.view', ok('Stock', paginatedSchema(shape)), { query: stockFilterQuerySchema });
route('get', '/inventory/movements', 'The ledger, newest first', 'inventory.view', ok('Movements', paginatedSchema(shape)), { query: movementsFilterQuerySchema });
route('get', '/inventory/signals', 'What needs attention at one branch', 'inventory.view', ok('Signals', shape), { query: branchScopeQuerySchema });
route('get', '/inventory/variants/{id}/threshold-suggestion', 'A reorder threshold suggested from sales', 'inventory.view', ok('Suggestion', shape), { ...params, query: branchScopeQuerySchema });
route('put', '/inventory/variants/{id}/threshold', "Set the branch's reorder threshold", 'inventory.receive', ok('Stock row', shape), { ...params, ...body(thresholdBodySchema) });
route('get', '/inventory/settings', 'Approval threshold and expiry warning window', 'inventory.view', ok('Settings', shape));
route('put', '/inventory/settings', 'Change them', 'inventory.approve', ok('Settings', shape), body(inventorySettingsBodySchema));

// ── Adjustments ─────────────────────────────────────────────────────────────
route('post', '/inventory/adjustments', 'Record damage or loss (posts at once under the threshold)', 'inventory.adjust', ok('Created', shape), body(adjustmentBodySchema));
route('get', '/inventory/adjustments', 'List adjustments', 'inventory.view', ok('Adjustments', paginatedSchema(shape)), { query: adjustmentsFilterQuerySchema });
route('get', '/inventory/adjustments/{id}', 'One adjustment with its lines', 'inventory.view', ok('Adjustment', shape), params);
route('post', '/inventory/adjustments/{id}/approve', 'Approve a pending adjustment (posts its movements)', 'inventory.approve', ok('Posted', shape), params, 200);
route('post', '/inventory/adjustments/{id}/reject', 'Reject it (nothing moves)', 'inventory.approve', ok('Rejected', shape), params, 200);

// ── Transfers and stocktakes — rest_api.md §23 ───────────────────────────────
route('post', '/inventory/transfers', 'Move stock between branches (unrestricted callers start it approved)', 'inventory.transfer', ok('Created', shape), body(transferBodySchema));
route('get', '/inventory/transfers', 'Transfers a branch sends or awaits', 'inventory.view', ok('Transfers', paginatedSchema(shape)), { query: transfersFilterQuerySchema });
route('get', '/inventory/transfers/{id}', 'One transfer with its lines and next states', 'inventory.view', ok('Transfer', shape), params);
route('post', '/inventory/transfers/{id}/approve', 'The sending branch agrees', 'inventory.transfer', ok('Approved', shape), params, 200);
route('post', '/inventory/transfers/{id}/reject', 'The sending branch refuses', 'inventory.transfer', ok('Rejected', shape), params, 200);
route('post', '/inventory/transfers/{id}/ship', 'Send it (leaves the sender at the sender’s cost)', 'inventory.transfer', ok('In transit', shape), params, 200);
route('post', '/inventory/transfers/{id}/receive', 'Receive what actually arrived', 'inventory.transfer', ok('Received', shape), params, 200);
route('post', '/inventory/transfers/{id}/resolve', 'Settle a shortfall as a loss or a return', 'inventory.transfer', ok('Resolved', shape), { ...params, ...body(resolveTransferBodySchema) }, 200);
route('post', '/inventory/transfers/{id}/close', 'Close it', 'inventory.transfer', ok('Closed', shape), params, 200);
route('post', '/inventory/counts', 'Open a stocktake (blind)', 'inventory.count', ok('Created', shape), body(countBodySchema));
route('get', '/inventory/counts', 'List stocktakes', 'inventory.view', ok('Counts', paginatedSchema(shape)), { query: countsFilterQuerySchema });
route('get', '/inventory/counts/{id}', 'One stocktake — system quantities stay null while it is open', 'inventory.view', ok('Count', shape), params);
route('post', '/inventory/counts/{id}/lines', 'Record a scanned quantity (re-scanning replaces the line)', 'inventory.count', ok('Recorded', shape), { ...params, ...body(countLineBodySchema) }, 200);
route('post', '/inventory/counts/{id}/close', 'Close it (posts under the threshold, waits above it)', 'inventory.count', ok('Closed', shape), params, 200);
route('post', '/inventory/counts/{id}/approve', 'Approve the differences (posts them)', 'inventory.approve', ok('Approved', shape), params, 200);
route('post', '/inventory/counts/{id}/reject', 'Reject them (nothing moves)', 'inventory.approve', ok('Rejected', shape), params, 200);

// ── Returning to the supplier — rest_api.md §24 ──────────────────────────────
route('get', '/inventory/receipts/{id}/returnable', 'What is still returnable on an invoice', 'inventory.receive', ok('Returnable lines', shape), params);
route('post', '/inventory/returns', 'Return goods against the invoice they arrived on', 'inventory.receive', ok('Created', shape), body(returnBodySchema));
route('get', '/inventory/returns', 'List returns', 'inventory.view', ok('Returns', paginatedSchema(shape)), { query: returnsFilterQuerySchema });
route('get', '/inventory/returns/{id}', 'One return with its lines', 'inventory.view', ok('Return', shape), params);
