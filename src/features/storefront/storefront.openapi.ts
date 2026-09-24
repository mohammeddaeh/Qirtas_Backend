import { z } from 'zod';
import { registry, successEnvelope, paginatedSchema, commonErrorResponses } from '../../core/openapi/registry.js';
import { idParamsSchema } from '../catalog/dtos/common.dto.js';
import { storefrontBranchShape, storefrontProductsShape } from './dtos/storefront.dto.js';

/**
 * The customer's side of the shop in the generated docs — the shapes are
 * written out in `docs/rest_api.md` §25.
 *
 * Every route here is **public**: a guest browses the whole catalogue, and the
 * only thing a session changes is that an approved wholesale buyer also sees
 * their own price.
 */

const tags = ['Storefront'];
const shape = z.object({}).passthrough();
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: successEnvelope(schema) } },
});

function route(
  path: string,
  summary: string,
  response: ReturnType<typeof ok>,
  request: Record<string, unknown> = {},
): void {
  registry.registerPath({
    method: 'get',
    path: `/api/v1${path}`,
    tags,
    summary,
    description: 'Public — a guest may call it. Response shape: rest_api.md §25.',
    request,
    responses: { 200: response, ...commonErrorResponses },
  });
}

route('/storefront/categories', 'The tree a customer browses, with live product counts', ok('Categories', z.array(shape)));
route('/storefront/collections', 'Shelves visible right now', ok('Collections', z.array(shape)));
route(
  '/storefront/products',
  'Products with their availability and price at the chosen branch',
  ok('Products', paginatedSchema(shape)),
  { query: storefrontProductsShape },
);
route('/storefront/products/{id}', 'One product, variant by variant', ok('Product', shape), {
  params: idParamsSchema,
  query: storefrontBranchShape,
});
