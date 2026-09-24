import { z } from 'zod';
import {
  registry,
  successEnvelope,
  paginatedSchema,
  commonErrorResponses,
} from '../../core/openapi/registry.js';
import { idParamsSchema } from '../catalog/dtos/common.dto.js';
import {
  archiveBodySchema,
  capBodySchema,
  previewBodySchema,
  promotionBodySchema,
  promotionsQuerySchema,
  targetsQuerySchema,
} from './dtos/promotions.dto.js';

/**
 * العروض بالوثائق المولَّدة — الأشكال كاملةً بـ`docs/rest_api.md` §26.
 */

const tags = ['Promotions'];
const shape = z.object({}).passthrough();
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: successEnvelope(schema) } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/promotions',
  tags,
  summary: 'Promotions, newest first',
  description: 'Requires `promotions.view`. Response shape: rest_api.md §26.',
  request: { query: promotionsQuerySchema },
  responses: { 200: ok('Promotions', paginatedSchema(shape)), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/promotions/signals',
  tags,
  summary: 'Live, ending soon, never-ending and scheduled counts',
  description: 'Requires `promotions.view`. A promotion with no end date is the one that sells at a loss for months.',
  responses: { 200: ok('Signals', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/promotions/caps',
  tags,
  summary: 'The discount ceiling each branch may give',
  description: 'Requires `promotions.view`.',
  responses: { 200: ok('Caps', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/promotions/targets',
  tags,
  summary: 'Names a promotion may target — variants, products, categories or brands',
  description:
    'Requires `promotions.view`. Search is the server-side one; the picker shows names, not ids.',
  request: { query: targetsQuerySchema },
  responses: { 200: ok('Targets', z.array(shape)), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/promotions/caps',
  tags,
  summary: 'Set one branch ceiling',
  description: 'Requires `pricing.policy` — whoever writes the pricing rules decides how far a branch may discount.',
  request: { body: { content: { 'application/json': { schema: capBodySchema } } } },
  responses: { 200: ok('Caps', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/promotions/preview',
  tags,
  summary: 'Price a hypothetical basket against every live promotion',
  description:
    'Requires `promotions.edit`. The only place «buy X get Y» can be seen working before a customer sees it.',
  request: { body: { content: { 'application/json': { schema: previewBodySchema } } } },
  responses: { 200: ok('Priced basket', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/promotions',
  tags,
  summary: 'Create a promotion',
  description:
    'Requires `promotions.edit`. Returns the promotion **and** `loss_warnings` — the items it sells below average cost.',
  request: { body: { content: { 'application/json': { schema: promotionBodySchema } } } },
  responses: { 201: ok('Created', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/promotions/{id}',
  tags,
  summary: 'One promotion',
  description: 'Requires `promotions.view`.',
  request: { params: idParamsSchema },
  responses: { 200: ok('Promotion', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/promotions/{id}',
  tags,
  summary: 'Replace a promotion',
  description: 'Requires `promotions.edit`. Every field travels — a promotion is a set of rules read together.',
  request: {
    params: idParamsSchema,
    body: { content: { 'application/json': { schema: promotionBodySchema } } },
  },
  responses: { 200: ok('Updated', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/promotions/{id}/archive',
  tags,
  summary: 'Archive or restore a promotion',
  description: 'Requires `promotions.edit`. Reversible — the invoices that cite it keep their answer.',
  request: {
    params: idParamsSchema,
    body: { content: { 'application/json': { schema: archiveBodySchema } } },
  },
  responses: { 200: ok('Promotion', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/promotions/{id}',
  tags,
  summary: 'Delete a promotion',
  description: 'Requires `promotions.edit`.',
  request: { params: idParamsSchema },
  responses: { 200: ok('Deleted', z.null()), ...commonErrorResponses },
});
