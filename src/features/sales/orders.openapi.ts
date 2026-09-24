import { z } from 'zod';
import {
  registry,
  successEnvelope,
  paginatedSchema,
  commonErrorResponses,
} from '../../core/openapi/registry.js';
import { idParamsSchema } from '../catalog/dtos/common.dto.js';
import {
  cancelOrderBodySchema,
  cartItemBodySchema,
  cartQtyBodySchema,
  cartQuerySchema,
  checkoutBodySchema,
  myOrdersQuerySchema,
  ordersQuerySchema,
} from './dtos/orders.dto.js';

/** السلّة والطلب بالوثائق المولَّدة — الأشكال كاملةً بـ`docs/rest_api.md` §28. */

const tags = ['Orders'];
const shape = z.object({}).passthrough();
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: successEnvelope(schema) } },
});
const body = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

// ── السلّة ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/cart',
  tags,
  summary: "The customer's cart at this branch, priced and checked now",
  description:
    'A signed-in customer. The cart **reserves nothing**: abandoned carts would freeze stock the till can see but cannot sell. Price and availability are read live — a stored price shows last week\'s amount.',
  request: { query: cartQuerySchema },
  responses: { 200: ok('Cart', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/cart/items',
  tags,
  summary: 'Add an item (a repeat raises the quantity)',
  description:
    'A signed-in customer. Two rows of five would miss the ten-piece tier and read as the same item ordered twice.',
  request: { query: cartQuerySchema, body: body(cartItemBodySchema) },
  responses: { 200: ok('Cart', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/cart/items',
  tags,
  summary: 'Set a line quantity — zero deletes the line',
  description: 'A signed-in customer. A zero row left in place reads as «I ordered it and it never came».',
  request: { query: cartQuerySchema, body: body(cartQtyBodySchema) },
  responses: { 200: ok('Cart', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/cart/items/{variantId}',
  tags,
  summary: 'Remove an item',
  description: 'A signed-in customer.',
  request: { query: cartQuerySchema },
  responses: { 200: ok('Cart', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/cart/checkout',
  tags,
  summary: 'Confirm the cart — spends a number, freezes the totals and reserves the stock',
  description:
    'A signed-in customer. **All four in one transaction.** The check is repeated inside the row lock: between filling the cart and pressing here, somebody else may buy the last piece. Refusals carry the available count, so the customer is not left guessing a smaller quantity.',
  request: { body: body(checkoutBodySchema) },
  responses: { 201: ok('Order', shape), ...commonErrorResponses },
});

// ── طلباتي ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/my-orders',
  tags,
  summary: "The customer's own orders",
  description: 'A signed-in customer. Scoped to the session, never to an id in the query.',
  request: { query: myOrdersQuerySchema },
  responses: { 200: ok('Orders', paginatedSchema(shape)), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/my-orders/{id}',
  tags,
  summary: 'One of my orders',
  description:
    "A signed-in customer. Somebody else's order is **not found**, not forbidden: forbidden confirms the number is real, so the next one gets tried.",
  request: { params: idParamsSchema },
  responses: { 200: ok('Order', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/my-orders/{id}/cancel',
  tags,
  summary: 'Cancel my order and release its reservation',
  description:
    'A signed-in customer. The release happens in the same transaction as the status change: a cancelled order whose goods stay reserved leaves the till looking at a full shelf it cannot sell.',
  request: { params: idParamsSchema, body: body(cancelOrderBodySchema) },
  responses: { 200: ok('Order', shape), ...commonErrorResponses },
});

// ── الطابور ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/orders',
  tags,
  summary: 'The branch order queue',
  description:
    'Requires `orders.view`. Reading the queue also sweeps whatever has run out of time — a scheduled job would be a second thing that must be running for the number to be true.',
  request: { query: ordersQuerySchema },
  responses: { 200: ok('Orders', paginatedSchema(shape)), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/orders/{id}',
  tags,
  summary: 'One order',
  description: 'Requires `orders.view`.',
  request: { params: idParamsSchema },
  responses: { 200: ok('Order', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/orders/{id}/pickup',
  tags,
  summary: 'Open a till basket filled from this order',
  description:
    'Requires `sales.sell` — whoever hands the goods over is whoever takes the money. The order keeps its reservation and **stops its clock** while the customer stands at the till; paying the basket closes the order and releases the hold in the same transaction as the stock issue.',
  request: { params: idParamsSchema },
  responses: { 200: ok('Order and its sale id', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/orders/{id}/cancel',
  tags,
  summary: 'The branch cancels an order',
  description: 'Requires `orders.manage_issues`. Releases the reservation in the same transaction.',
  request: { params: idParamsSchema, body: body(cancelOrderBodySchema) },
  responses: { 200: ok('Order', shape), ...commonErrorResponses },
});
