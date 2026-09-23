import { z } from 'zod';
import {
  registry,
  successEnvelope,
  paginatedSchema,
  commonErrorResponses,
} from '../../core/openapi/registry.js';
import { imageResponseSchema } from '../../core/media/dtos/files.dto.js';
import { idParamsSchema } from './dtos/common.dto.js';
import {
  branchPriceBodySchema,
  branchVariantParamsSchema,
  bulkPriceBodySchema,
  categoryPricingRulesBodySchema,
  centralPriceBodySchema,
  exchangeRateBodySchema,
  listingBodySchema,
  pricingViewQuerySchema,
  productPricingRulesBodySchema,
  roundingBodySchema,
} from './dtos/pricing.dto.js';
import {
  createUnitBodySchema,
  unitResponseSchema,
  updateUnitBodySchema,
} from './dtos/units.dto.js';
import {
  attributeTypeResponseSchema,
  attributeValueResponseSchema,
  createAttributeTypeBodySchema,
  createAttributeValueBodySchema,
  updateAttributeTypeBodySchema,
  updateAttributeValueBodySchema,
} from './dtos/attributes.dto.js';
import {
  categoriesFilterQuerySchema,
  categoryDetailResponseSchema,
  categoryResponseSchema,
  createCategoryBodySchema,
  replaceCategoryAttributesBodySchema,
  updateCategoryBodySchema,
} from './dtos/categories.dto.js';
import {
  brandResponseSchema,
  brandsFilterQuerySchema,
  createBrandBodySchema,
  updateBrandBodySchema,
} from './dtos/brands.dto.js';
import {
  addBarcodeBodySchema,
  barcodeLookupQuerySchema,
  barcodeLookupResponseSchema,
  createProductBodySchema,
  generateBarcodeBodySchema,
  productDetailSchema,
  productListItemSchema,
  productsFilterQuerySchema,
  replaceVariantUnitsBodySchema,
  sharedBarcodeSchema,
  updateProductBodySchema,
  updateVariantBodySchema,
  variantInputSchema,
} from './dtos/products.dto.js';
import {
  collectionDetailResponseSchema,
  collectionResponseSchema,
  createCollectionBodySchema,
  replaceCollectionProductsBodySchema,
  updateCollectionBodySchema,
} from './dtos/collections.dto.js';

const tags = ['Catalog'];
const json = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  ...json(successEnvelope(schema)),
});
const deleted = { description: 'Deleted', ...json(successEnvelope(z.null())) };

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
function route(
  method: Method,
  path: string,
  summary: string,
  key: string,
  response: ReturnType<typeof ok> | typeof deleted,
  request: Record<string, unknown> = {},
  description?: string,
  status?: number,
): void {
  registry.registerPath({
    method,
    path: `/api/v1/catalog${path}`,
    tags,
    summary,
    description: `Requires \`${key}\`.${description ? ` ${description}` : ''}`,
    request,
    responses: {
      [status ?? (method === 'post' && !path.includes('/archive') ? 201 : 200)]: response,
      ...commonErrorResponses,
    },
  });
}

registry.registerPath({
  method: 'post',
  path: '/api/v1/catalog/media/images',
  tags,
  summary: 'Upload a catalog image',
  description:
    'Requires `catalog.edit`. Multipart, field `file`, ≤ 10 MB, JPEG/PNG/WebP, shortest edge ≥ 200 px. ' +
    'Stored as three WebP renditions (thumb 320 · medium 800 · large 1600) with metadata stripped. ' +
    'The image is unattached until a catalog record referencing its `id` is saved.',
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ file: z.string().openapi({ type: 'string', format: 'binary' }) }),
        },
      },
    },
  },
  responses: {
    201: ok('Stored image with relative URLs per rendition', imageResponseSchema),
    ...commonErrorResponses,
  },
});

const params = { params: idParamsSchema };
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: json(schema) });

route('get', '/units', 'List units', 'catalog.view', ok('Units', z.array(unitResponseSchema)));
route(
  'post',
  '/units',
  'Create a unit',
  'catalog.create',
  ok('Created', unitResponseSchema),
  body(createUnitBodySchema),
);
route(
  'patch',
  '/units/{id}',
  'Update a unit',
  'catalog.edit',
  ok('Updated', unitResponseSchema),
  {
    ...params,
    ...body(updateUnitBodySchema),
  },
  '`allows_fraction` cannot change — a different fraction rule is a different unit.',
);

route(
  'get',
  '/attributes',
  'List the attribute library with values',
  'catalog.view',
  ok('Attribute types', z.array(attributeTypeResponseSchema)),
);
route(
  'post',
  '/attributes',
  'Create an attribute type',
  'catalog.create',
  ok('Created', attributeTypeResponseSchema),
  body(createAttributeTypeBodySchema),
);
route(
  'patch',
  '/attributes/{id}',
  'Update an attribute type',
  'catalog.edit',
  ok('Updated', attributeTypeResponseSchema),
  {
    ...params,
    ...body(updateAttributeTypeBodySchema),
  },
);
route(
  'delete',
  '/attributes/{id}',
  'Delete an attribute type and its values',
  'catalog.delete',
  deleted,
  params,
  '409 `attribute_type_in_use` while any category allows it.',
);
route(
  'post',
  '/attributes/{id}/values',
  'Add a value to an attribute',
  'catalog.edit',
  ok('Created', attributeValueResponseSchema),
  {
    ...params,
    ...body(createAttributeValueBodySchema),
  },
  '409 `attribute_value_taken` — compared after folding Arabic spellings.',
);
route(
  'patch',
  '/attribute-values/{id}',
  'Update an attribute value',
  'catalog.edit',
  ok('Updated', attributeValueResponseSchema),
  {
    ...params,
    ...body(updateAttributeValueBodySchema),
  },
);
route(
  'delete',
  '/attribute-values/{id}',
  'Delete an attribute value',
  'catalog.delete',
  deleted,
  params,
);

route(
  'get',
  '/categories',
  'List the category tree (flat)',
  'catalog.view',
  ok('Categories', z.array(categoryResponseSchema)),
  {
    query: categoriesFilterQuerySchema,
  },
  '`archived=true` returns the archive only.',
);
route(
  'get',
  '/categories/{id}',
  'Get a category with its attributes and removal verdicts',
  'catalog.view',
  ok('Category', categoryDetailResponseSchema),
  params,
);
route(
  'post',
  '/categories',
  'Create a category',
  'catalog.create',
  ok('Created', categoryDetailResponseSchema),
  body(createCategoryBodySchema),
  '422 `category_too_deep` past three levels · 409 `category_name_taken` / `category_name_taken_by_archived` among siblings · 409 `category_parent_archived`.',
);
route(
  'patch',
  '/categories/{id}',
  'Update or move a category',
  'catalog.edit',
  ok('Updated', categoryDetailResponseSchema),
  {
    ...params,
    ...body(updateCategoryBodySchema),
  },
  'Moving re-levels the whole subtree. 422 `category_parent_invalid` under itself/a descendant · 409 `category_archived`.',
);
route(
  'put',
  '/categories/{id}/attributes',
  "Replace the category's own allowed attributes",
  'catalog.edit',
  ok('Updated', categoryDetailResponseSchema),
  {
    ...params,
    ...body(replaceCategoryAttributesBodySchema),
  },
);
route(
  'delete',
  '/categories/{id}',
  'Delete a category nothing hangs under',
  'catalog.delete',
  deleted,
  params,
  '409 `category_has_children` — any child, archived included.',
);
route(
  'post',
  '/categories/{id}/archive',
  'Archive a category',
  'catalog.delete + records.archive',
  ok('Archived', categoryDetailResponseSchema),
  params,
  '409 `category_has_active_children`. Idempotent.',
);
route(
  'post',
  '/categories/{id}/unarchive',
  'Restore an archived category',
  'catalog.delete + records.archive',
  ok('Restored', categoryDetailResponseSchema),
  params,
  '409 `category_parent_archived` · `category_name_taken`. Idempotent.',
);

route(
  'get',
  '/brands',
  'List brands (paginated, folded search)',
  'catalog.view',
  ok('Brands', paginatedSchema(brandResponseSchema)),
  {
    query: brandsFilterQuerySchema,
  },
);
route(
  'post',
  '/brands',
  'Create a brand',
  'catalog.create',
  ok('Created', brandResponseSchema),
  body(createBrandBodySchema),
);
route(
  'patch',
  '/brands/{id}',
  'Update a brand',
  'catalog.edit',
  ok('Updated', brandResponseSchema),
  {
    ...params,
    ...body(updateBrandBodySchema),
  },
);
route('delete', '/brands/{id}', 'Delete a brand', 'catalog.delete', deleted, params);
route(
  'post',
  '/brands/{id}/archive',
  'Archive a brand',
  'catalog.delete + records.archive',
  ok('Archived', brandResponseSchema),
  params,
);
route(
  'post',
  '/brands/{id}/unarchive',
  'Restore a brand',
  'catalog.delete + records.archive',
  ok('Restored', brandResponseSchema),
  params,
);

// ── Products, variants, barcodes ────────────────────────────────────────────
route(
  'get',
  '/products',
  'List products',
  'catalog.view',
  ok('Products', paginatedSchema(productListItemSchema)),
  {
    query: productsFilterQuerySchema,
  },
  '`search` is folded Arabic over names + keywords; a code-shaped term also matches a barcode or SKU exactly. `category_id` includes subcategories.',
);
route(
  'get',
  '/products/{id}',
  'Get a product with variants, units and barcodes',
  'catalog.view',
  ok('Product', productDetailSchema),
  params,
);
route(
  'post',
  '/products',
  'Create a product with its variants',
  'catalog.create',
  ok('Created', productDetailSchema),
  body(createProductBodySchema),
  'Leaf category only (422 `category_not_leaf`). Variants share the same attributes (422 `variant_axes_mismatch`), ≤ 3 (422 `variant_too_many_axes`), allowed by the category (422 `variant_attribute_not_allowed`), unique combination (409 `variant_combination_taken`). Barcodes: 422 `barcode_format_invalid` / `barcode_checksum_invalid`. A shared code is accepted.',
);
route(
  'patch',
  '/products/{id}',
  'Update a product',
  'catalog.edit',
  ok('Updated', productDetailSchema),
  { ...params, ...body(updateProductBodySchema) },
  '409 `product_archived` · 409 `product_attributes_not_allowed_in_category` on a category change · 422 `product_needs_active_variant`.',
);
route('delete', '/products/{id}', 'Delete a product', 'catalog.delete', deleted, params);
route(
  'post',
  '/products/{id}/archive',
  'Archive a product',
  'catalog.delete + records.archive',
  ok('Archived', productDetailSchema),
  params,
);
route(
  'post',
  '/products/{id}/unarchive',
  'Restore a product',
  'catalog.delete + records.archive',
  ok('Restored', productDetailSchema),
  params,
  '409 `product_category_archived`.',
);
route(
  'post',
  '/products/{id}/variants',
  'Add a variant',
  'catalog.edit',
  ok('Product with the new variant', productDetailSchema),
  { ...params, ...body(variantInputSchema) },
);
route(
  'patch',
  '/variants/{id}',
  'Update a variant',
  'catalog.edit',
  ok('Product', productDetailSchema),
  { ...params, ...body(updateVariantBodySchema) },
  '`base_unit_id` is not editable — stock is counted in it.',
);
route(
  'delete',
  '/variants/{id}',
  'Delete a variant',
  'catalog.edit',
  ok('Product', productDetailSchema),
  params,
  '409 `product_needs_variant` for the last one.',
);
route(
  'put',
  '/variants/{id}/units',
  'Replace a variant’s units',
  'catalog.edit',
  ok('Product', productDetailSchema),
  { ...params, ...body(replaceVariantUnitsBodySchema) },
  'The base unit stays with factor 1. 422 `variant_unit_factor_invalid` (factor ≤ 1) · 409 `variant_unit_has_barcodes`.',
);
route(
  'post',
  '/variants/{id}/barcodes',
  'Add a manufacturer barcode',
  'catalog.edit',
  ok('Product', productDetailSchema),
  { ...params, ...body(addBarcodeBodySchema) },
  '409 `barcode_already_on_unit`. The same code on another unit or variant is accepted and flagged `is_shared`.',
);
route(
  'post',
  '/variants/{id}/barcodes/internal',
  'Generate an internal EAN-13 (prefix 20)',
  'barcodes.print',
  ok('Product', productDetailSchema),
  {
    ...params,
    ...body(generateBarcodeBodySchema),
  },
);
route(
  'delete',
  '/barcodes/{id}',
  'Remove a barcode',
  'catalog.edit',
  ok('Product', productDetailSchema),
  params,
);
route(
  'get',
  '/barcodes/lookup',
  'Resolve a scanned code',
  'catalog.view',
  ok('Matches', barcodeLookupResponseSchema),
  { query: barcodeLookupQuerySchema },
  '`ambiguity`: `none` (add it) · `unit` (one variant, several units — offer units) · `item` (several variants — offer variants). Archived products are excluded.',
);
route(
  'get',
  '/barcodes/shared',
  'Codes printed on more than one variant/unit',
  'catalog.view',
  ok('Shared codes', z.array(sharedBarcodeSchema)),
);

// ── Collections ─────────────────────────────────────────────────────────────
route(
  'get',
  '/collections',
  'List collections',
  'catalog.view',
  ok('Collections', z.array(collectionResponseSchema)),
);
route(
  'get',
  '/collections/{id}',
  'Get a collection with its products',
  'catalog.view',
  ok('Collection', collectionDetailResponseSchema),
  params,
);
route(
  'post',
  '/collections',
  'Create a collection',
  'catalog.create',
  ok('Created', collectionDetailResponseSchema),
  body(createCollectionBodySchema),
);
route(
  'patch',
  '/collections/{id}',
  'Update a collection',
  'catalog.edit',
  ok('Updated', collectionDetailResponseSchema),
  { ...params, ...body(updateCollectionBodySchema) },
);
route(
  'put',
  '/collections/{id}/products',
  'Replace a collection’s products (in order)',
  'catalog.edit',
  ok('Updated', collectionDetailResponseSchema),
  {
    ...params,
    ...body(replaceCollectionProductsBodySchema),
  },
);
route('delete', '/collections/{id}', 'Delete a collection', 'catalog.delete', deleted, params);

// ── Pricing — rest_api.md §21 (shapes documented there) ──────────────────
const pricingShape = z.object({}).passthrough();
const see = 'Response shape: rest_api.md §21.';
const branchVariant = { params: branchVariantParamsSchema };
const view = { query: pricingViewQuerySchema };
route('get', '/pricing/settings', 'Exchange rate and rounding bands', 'catalog.view', ok('Settings', pricingShape));
route('post', '/pricing/exchange-rate', 'Record a new USD→SYP rate (appended, never edited)', 'pricing.policy', ok('Settings', pricingShape), body(exchangeRateBodySchema), undefined, 200);
route('put', '/pricing/rounding', 'Replace the rounding bands', 'pricing.policy', ok('Settings', pricingShape), body(roundingBodySchema));
route('get', '/pricing/worklist', 'Sellable variants with no price, or pushed out of their band', 'catalog.view', ok('Worklist', pricingShape), view, see);
route('post', '/pricing/bulk/preview', 'Preview a percentage change to central prices', 'pricing.policy', ok('Preview', pricingShape), body(bulkPriceBodySchema), see, 200);
route('post', '/pricing/bulk/apply', 'Apply a percentage change to central prices (re-planned, not the preview)', 'pricing.policy', ok('Applied', pricingShape), body(bulkPriceBodySchema), see, 200);
route('get', '/products/{id}/pricing', 'A product’s prices — central, or seen from one branch', 'catalog.view', ok('Pricing', pricingShape), { ...params, ...view }, see);
route('put', '/products/{id}/pricing-rules', 'Override the band for one product', 'pricing.policy', ok('Pricing', pricingShape), { ...params, ...body(productPricingRulesBodySchema) });
route('put', '/categories/{id}/pricing-rules', 'Set a category’s band, wholesale and tax rules (null = inherit)', 'pricing.policy', ok('Category detail', categoryDetailResponseSchema), { ...params, ...body(categoryPricingRulesBodySchema) });
route('put', '/variants/{id}/price', 'Set the central price', 'pricing.edit (unrestricted)', ok('Pricing', pricingShape), { ...params, ...body(centralPriceBodySchema) }, see);
route('get', '/variants/{id}/price-history', 'Price changes, newest first', 'catalog.view', ok('History', pricingShape), params, see);
route('put', '/branches/{branchId}/variants/{variantId}/price', 'Set a branch price (scope checked against the product’s policy)', 'pricing.edit', ok('Pricing', pricingShape), { ...branchVariant, ...body(branchPriceBodySchema) }, see);
route('delete', '/branches/{branchId}/variants/{variantId}/price', 'Clear a branch price (back to central)', 'pricing.edit', ok('Pricing', pricingShape), branchVariant, see);
route('put', '/branches/{branchId}/variants/{variantId}/listing', 'List or withdraw a variant at a branch', 'pricing.edit', ok('Pricing', pricingShape), { ...branchVariant, ...body(listingBodySchema) }, see);
