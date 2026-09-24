import { z } from 'zod';
import {
  registry,
  successEnvelope,
  paginatedSchema,
  commonErrorResponses,
} from '../../core/openapi/registry.js';
import { idParamsSchema } from '../catalog/dtos/common.dto.js';
import {
  addLineBodySchema,
  approveDiscountBodySchema,
  capBodySchema,
  creditLimitBodySchema,
  discountBodySchema,
  discountCheckQuerySchema,
  heldBodySchema,
  ledgerBodySchema,
  lineQtyBodySchema,
  openSaleBodySchema,
  openSalesQuerySchema,
  payBodySchema,
  salesQuerySchema,
  sellableItemsQuerySchema,
} from './dtos/sales.dto.js';

/** نقطة البيع بالوثائق المولَّدة — الأشكال كاملةً بـ`docs/rest_api.md` §27. */

const tags = ['Sales'];
const shape = z.object({}).passthrough();
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: successEnvelope(schema) } },
});
const body = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sales',
  tags,
  summary: 'Open a till basket',
  description:
    'Requires `sales.sell`. The basket takes **no invoice number and reserves no stock** — a number spent on a cancelled basket is exactly the gap gapless numbering exists to prevent.',
  request: { body: body(openSaleBodySchema) },
  responses: { 201: ok('Sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sales/open',
  tags,
  summary: "This cashier's open and held baskets",
  description: 'Requires `sales.sell`. Only this cashier: a colleague basket read here as forgotten gets cancelled while its customer waits at the other till.',
  request: { query: openSalesQuerySchema },
  responses: { 200: ok('Sales', z.array(shape)), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sales/discount-check',
  tags,
  summary: 'May this cashier give that discount',
  description:
    'Requires `sales.sell`. Three answers, not two: within cap · needs a manager · refused outright. Asked **before** the cashier promises the customer anything.',
  request: { query: discountCheckQuerySchema },
  responses: { 200: ok('Verdict', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sales/items',
  tags,
  summary: 'What the till may sell, with its price and stock at this branch',
  description:
    'Requires `sales.sell`. A row that matched a barcode **exactly** is flagged, so one scan adds one item instead of asking the cashier to read five names.',
  request: { query: sellableItemsQuerySchema },
  responses: { 200: ok('Items', z.array(shape)), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sales/caps',
  tags,
  summary: 'The manual-discount ceiling of each role',
  description: 'Requires `sales.view`.',
  responses: { 200: ok('Caps', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/sales/caps',
  tags,
  summary: 'Set one role ceiling',
  description: 'Requires `sales.manage`. A number on the role, not a permission key — RBAC answers yes/no, and "how much may you discount" is answered by a percentage.',
  request: { body: body(capBodySchema) },
  responses: { 200: ok('Caps', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sales',
  tags,
  summary: 'Sales, newest first',
  description: 'Requires `sales.view`. Response shape: rest_api.md §27.',
  request: { query: salesQuerySchema },
  responses: { 200: ok('Sales', paginatedSchema(shape)), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sales/{id}',
  tags,
  summary: 'One sale with its lines and payments',
  description:
    'Requires `sales.view`. A paid sale reads its **frozen** totals; an open basket is computed live — recomputing a paid one would read a promotion that has since ended.',
  request: { params: idParamsSchema },
  responses: { 200: ok('Sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sales/{id}/lines',
  tags,
  summary: 'Add an item (price comes from the server)',
  description:
    'Requires `sales.sell`. A price sent by the device is a discount written by whoever holds it, with nothing on the invoice saying so. Scanning the same item twice **raises the quantity**.',
  request: { params: idParamsSchema, body: body(addLineBodySchema) },
  responses: { 200: ok('Sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/sales/{id}/lines/{lineId}',
  tags,
  summary: 'Change a line quantity (zero removes it)',
  description: 'Requires `sales.sell`.',
  request: { body: body(lineQtyBodySchema) },
  responses: { 200: ok('Sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/sales/{id}/lines/{lineId}',
  tags,
  summary: 'Remove a line',
  description: 'Requires `sales.sell`.',
  responses: { 200: ok('Sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sales/{id}/hold',
  tags,
  summary: 'Hold or resume a basket',
  description: 'Requires `sales.sell`. A state, not a delete — the basket waits for its owner.',
  request: { params: idParamsSchema, body: body(heldBodySchema) },
  responses: { 200: ok('Sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sales/{id}/void',
  tags,
  summary: 'Cancel a basket before payment',
  description: 'Requires `sales.sell`. No number was spent, so no gap appears.',
  request: { params: idParamsSchema },
  responses: { 200: ok('Sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sales/{id}/discount',
  tags,
  summary: 'Apply a manual discount (reason required)',
  description: 'Requires `sales.sell`. Above the cashier cap the call is refused until a manager approves.',
  request: { params: idParamsSchema, body: body(discountBodySchema) },
  responses: { 200: ok('Sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sales/{id}/discount/approve',
  tags,
  summary: 'Manager approval on the same device',
  description:
    'Requires `sales.sell`. Verifies the manager email and password and records their name on the invoice — **and issues no session**: a second token left on the till outlives the manager who walked away.',
  request: { params: idParamsSchema, body: body(approveDiscountBodySchema) },
  responses: { 200: ok('Sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sales/{id}/pay',
  tags,
  summary: 'Settle the sale',
  description:
    'Requires `sales.sell`. Spends the invoice number, freezes the totals, issues the stock and posts the customer ledger — **all in one transaction**.',
  request: { params: idParamsSchema, body: body(payBodySchema) },
  responses: { 200: ok('Paid sale', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/customers/{id}/account',
  tags,
  summary: 'Customer balance, limit and ledger',
  description: 'Requires `sales.view`. The balance is the **sum of the ledger**, never a stored column.',
  request: { params: idParamsSchema },
  responses: { 200: ok('Account', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/customers/{id}/account/limit',
  tags,
  summary: 'Set the credit limit',
  description: 'Requires `sales.manage`. No row means **no credit at all** — an open default lends to every customer silently.',
  request: { params: idParamsSchema, body: body(creditLimitBodySchema) },
  responses: { 200: ok('Account', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/customers/{id}/account/entries',
  tags,
  summary: 'Settle a debt or deposit credit',
  description: 'Requires `sales.manage`. Append-only: a correction is another entry, never an edit.',
  request: { params: idParamsSchema, body: body(ledgerBodySchema) },
  responses: { 200: ok('Account', shape), ...commonErrorResponses },
});
