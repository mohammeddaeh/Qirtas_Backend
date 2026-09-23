import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { validate } from '../../../core/validation/validate.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import { uploadImageFile } from '../../../core/media/middleware/upload-image.js';
import { idParamsSchema } from '../dtos/common.dto.js';
import {
  branchPriceBodySchema,
  branchVariantParamsSchema,
  bulkPriceBodySchema,
  categoryPricingRulesBodySchema,
  centralPriceBodySchema,
  productPricingRulesBodySchema,
  exchangeRateBodySchema,
  listingBodySchema,
  pricingViewQuerySchema,
  roundingBodySchema,
} from '../dtos/pricing.dto.js';
import { createUnitBodySchema, updateUnitBodySchema } from '../dtos/units.dto.js';
import {
  createAttributeTypeBodySchema,
  createAttributeValueBodySchema,
  updateAttributeTypeBodySchema,
  updateAttributeValueBodySchema,
} from '../dtos/attributes.dto.js';
import {
  categoriesFilterQuerySchema,
  createCategoryBodySchema,
  replaceCategoryAttributesBodySchema,
  updateCategoryBodySchema,
} from '../dtos/categories.dto.js';
import {
  brandsFilterQuerySchema,
  createBrandBodySchema,
  updateBrandBodySchema,
} from '../dtos/brands.dto.js';
import * as catalogMediaController from '../controllers/catalog-media.controller.js';
import * as pricingController from '../controllers/pricing.controller.js';
import * as unitsController from '../controllers/units.controller.js';
import * as attributesController from '../controllers/attributes.controller.js';
import * as categoriesController from '../controllers/categories.controller.js';
import * as brandsController from '../controllers/brands.controller.js';
import * as productsController from '../controllers/products.controller.js';
import * as collectionsController from '../controllers/collections.controller.js';
import {
  addBarcodeBodySchema,
  barcodeLookupQuerySchema,
  createProductBodySchema,
  generateBarcodeBodySchema,
  productsFilterQuerySchema,
  replaceVariantUnitsBodySchema,
  updateProductBodySchema,
  updateVariantBodySchema,
  variantInputSchema,
} from '../dtos/products.dto.js';
import {
  createCollectionBodySchema,
  replaceCollectionProductsBodySchema,
  updateCollectionBodySchema,
} from '../dtos/collections.dto.js';

/**
 * The central catalog — docs/reference/store_system.md §قرارات 2026-09-22.
 *
 * One key per decision (§١٠): `catalog.view` reads the admin side, `create` /
 * `edit` / `delete` change it, and `catalog.manage` is the umbrella granted to
 * whoever owns the whole catalog. Retiring a record with a past additionally
 * needs `records.archive`, exactly as branches, roles and users do.
 *
 * The customer-facing reads (active tree, product pages) arrive with phase 5
 * as their own public routes; these are the staff routes.
 */
export const catalogRouter = Router();

const canView = requirePermission('catalog.view', {
  display: { ar: 'عرض الكتالوج', en: 'View Catalog' },
});
const canCreate = requirePermission('catalog.create', {
  display: { ar: 'إضافة إلى الكتالوج', en: 'Add to Catalog' },
});
const canEdit = requirePermission('catalog.edit', {
  display: { ar: 'تعديل الكتالوج', en: 'Edit Catalog' },
});
const canDelete = requirePermission('catalog.delete', {
  display: { ar: 'حذف وأرشفة من الكتالوج', en: 'Delete or Archive Catalog Items' },
  sensitive: true,
});
const canArchive = requirePermission('records.archive');
const withId = validate(idParamsSchema, 'params');

// ── Images ────────────────────────────────────────────────────────────────
// Uploading is part of editing. Guard BEFORE the multipart parser: an
// unauthorised caller must not stream ten megabytes into memory first.
catalogRouter.post(
  '/media/images',
  canEdit,
  uploadImageFile,
  asyncHandler(catalogMediaController.uploadImage),
);

// ── Units ─────────────────────────────────────────────────────────────────
catalogRouter.get('/units', canView, asyncHandler(unitsController.listUnits));
catalogRouter.post(
  '/units',
  canCreate,
  validate(createUnitBodySchema, 'body'),
  asyncHandler(unitsController.createUnit),
);
catalogRouter.patch(
  '/units/:id',
  canEdit,
  withId,
  validate(updateUnitBodySchema, 'body'),
  asyncHandler(unitsController.updateUnit),
);

// ── Attribute library ─────────────────────────────────────────────────────
catalogRouter.get('/attributes', canView, asyncHandler(attributesController.listAttributeTypes));
catalogRouter.post(
  '/attributes',
  canCreate,
  validate(createAttributeTypeBodySchema, 'body'),
  asyncHandler(attributesController.createAttributeType),
);
catalogRouter.patch(
  '/attributes/:id',
  canEdit,
  withId,
  validate(updateAttributeTypeBodySchema, 'body'),
  asyncHandler(attributesController.updateAttributeType),
);
catalogRouter.delete(
  '/attributes/:id',
  canDelete,
  withId,
  asyncHandler(attributesController.deleteAttributeType),
);
// Adding a value to an existing attribute edits the library, it does not create a new entry in it.
catalogRouter.post(
  '/attributes/:id/values',
  canEdit,
  withId,
  validate(createAttributeValueBodySchema, 'body'),
  asyncHandler(attributesController.createAttributeValue),
);
catalogRouter.patch(
  '/attribute-values/:id',
  canEdit,
  withId,
  validate(updateAttributeValueBodySchema, 'body'),
  asyncHandler(attributesController.updateAttributeValue),
);
catalogRouter.delete(
  '/attribute-values/:id',
  canDelete,
  withId,
  asyncHandler(attributesController.deleteAttributeValue),
);

// ── Categories ────────────────────────────────────────────────────────────
catalogRouter.get(
  '/categories',
  canView,
  validate(categoriesFilterQuerySchema, 'query'),
  asyncHandler(categoriesController.listCategories),
);
catalogRouter.get(
  '/categories/:id',
  canView,
  withId,
  asyncHandler(categoriesController.getCategory),
);
catalogRouter.post(
  '/categories',
  canCreate,
  validate(createCategoryBodySchema, 'body'),
  asyncHandler(categoriesController.createCategory),
);
catalogRouter.patch(
  '/categories/:id',
  canEdit,
  withId,
  validate(updateCategoryBodySchema, 'body'),
  asyncHandler(categoriesController.updateCategory),
);
catalogRouter.put(
  '/categories/:id/attributes',
  canEdit,
  withId,
  validate(replaceCategoryAttributesBodySchema, 'body'),
  asyncHandler(categoriesController.replaceCategoryAttributes),
);
catalogRouter.delete(
  '/categories/:id',
  canDelete,
  withId,
  asyncHandler(categoriesController.deleteCategory),
);
catalogRouter.post(
  '/categories/:id/archive',
  canDelete,
  canArchive,
  withId,
  asyncHandler(categoriesController.archiveCategory),
);
catalogRouter.post(
  '/categories/:id/unarchive',
  canDelete,
  canArchive,
  withId,
  asyncHandler(categoriesController.unarchiveCategory),
);

// ── Brands ────────────────────────────────────────────────────────────────
catalogRouter.get(
  '/brands',
  canView,
  validate(paginationQuerySchema.merge(brandsFilterQuerySchema), 'query'),
  asyncHandler(brandsController.listBrands),
);
catalogRouter.post(
  '/brands',
  canCreate,
  validate(createBrandBodySchema, 'body'),
  asyncHandler(brandsController.createBrand),
);
catalogRouter.patch(
  '/brands/:id',
  canEdit,
  withId,
  validate(updateBrandBodySchema, 'body'),
  asyncHandler(brandsController.updateBrand),
);
catalogRouter.delete('/brands/:id', canDelete, withId, asyncHandler(brandsController.deleteBrand));
catalogRouter.post(
  '/brands/:id/archive',
  canDelete,
  canArchive,
  withId,
  asyncHandler(brandsController.archiveBrand),
);
catalogRouter.post(
  '/brands/:id/unarchive',
  canDelete,
  canArchive,
  withId,
  asyncHandler(brandsController.unarchiveBrand),
);

// ── Products ──────────────────────────────────────────────────────────────
catalogRouter.get(
  '/products',
  canView,
  validate(paginationQuerySchema.merge(productsFilterQuerySchema), 'query'),
  asyncHandler(productsController.listProducts),
);
catalogRouter.get('/products/:id', canView, withId, asyncHandler(productsController.getProduct));
catalogRouter.post(
  '/products',
  canCreate,
  validate(createProductBodySchema, 'body'),
  asyncHandler(productsController.createProduct),
);
catalogRouter.patch(
  '/products/:id',
  canEdit,
  withId,
  validate(updateProductBodySchema, 'body'),
  asyncHandler(productsController.updateProduct),
);
catalogRouter.delete(
  '/products/:id',
  canDelete,
  withId,
  asyncHandler(productsController.deleteProduct),
);
catalogRouter.post(
  '/products/:id/archive',
  canDelete,
  canArchive,
  withId,
  asyncHandler(productsController.archiveProduct),
);
catalogRouter.post(
  '/products/:id/unarchive',
  canDelete,
  canArchive,
  withId,
  asyncHandler(productsController.unarchiveProduct),
);

// ── Variants ──────────────────────────────────────────────────────────────
// A new variant edits an existing product; it does not add a product.
catalogRouter.post(
  '/products/:id/variants',
  canEdit,
  withId,
  validate(variantInputSchema, 'body'),
  asyncHandler(productsController.addVariant),
);
catalogRouter.patch(
  '/variants/:id',
  canEdit,
  withId,
  validate(updateVariantBodySchema, 'body'),
  asyncHandler(productsController.updateVariant),
);
catalogRouter.delete(
  '/variants/:id',
  canEdit,
  withId,
  asyncHandler(productsController.deleteVariant),
);
catalogRouter.put(
  '/variants/:id/units',
  canEdit,
  withId,
  validate(replaceVariantUnitsBodySchema, 'body'),
  asyncHandler(productsController.replaceVariantUnits),
);

// ── Barcodes ──────────────────────────────────────────────────────────────
// Reading a scan is part of viewing the catalog; `/lookup` and `/shared`
// are registered before `/:id` so the literal paths are not read as ids.
catalogRouter.get(
  '/barcodes/lookup',
  canView,
  validate(barcodeLookupQuerySchema, 'query'),
  asyncHandler(productsController.lookupBarcode),
);
catalogRouter.get('/barcodes/shared', canView, asyncHandler(productsController.listSharedBarcodes));
catalogRouter.post(
  '/variants/:id/barcodes',
  canEdit,
  withId,
  validate(addBarcodeBodySchema, 'body'),
  asyncHandler(productsController.addBarcode),
);
catalogRouter.post(
  '/variants/:id/barcodes/internal',
  requirePermission('barcodes.print', {
    display: { ar: 'توليد الباركود وطباعة الملصقات', en: 'Generate Barcodes & Print Labels' },
  }),
  withId,
  validate(generateBarcodeBodySchema, 'body'),
  asyncHandler(productsController.generateBarcode),
);
catalogRouter.delete(
  '/barcodes/:id',
  canEdit,
  withId,
  asyncHandler(productsController.deleteBarcode),
);

// ── Collections ───────────────────────────────────────────────────────────
catalogRouter.get('/collections', canView, asyncHandler(collectionsController.listCollections));
catalogRouter.get(
  '/collections/:id',
  canView,
  withId,
  asyncHandler(collectionsController.getCollection),
);
catalogRouter.post(
  '/collections',
  canCreate,
  validate(createCollectionBodySchema, 'body'),
  asyncHandler(collectionsController.createCollection),
);
catalogRouter.patch(
  '/collections/:id',
  canEdit,
  withId,
  validate(updateCollectionBodySchema, 'body'),
  asyncHandler(collectionsController.updateCollection),
);
catalogRouter.put(
  '/collections/:id/products',
  canEdit,
  withId,
  validate(replaceCollectionProductsBodySchema, 'body'),
  asyncHandler(collectionsController.replaceCollectionProducts),
);
catalogRouter.delete(
  '/collections/:id',
  canDelete,
  withId,
  asyncHandler(collectionsController.deleteCollection),
);

// ── Pricing (store_system.md §١١) ─────────────────────────────────────────
// Reading a price is part of viewing the catalog. Writing needs `pricing.edit`
// *somewhere*; the service then checks the scope the row demands (the central
// price and `central_locked` exceptions need it unrestricted, a branch's own
// price needs it at that branch) — a route guard cannot know the product's
// policy. Settings, rates and bulk changes move every price: `pricing.policy`.
const canEditPrice = requirePermission('pricing.edit', {
  display: { ar: 'تعديل الأسعار', en: 'Edit Prices' },
  sensitive: true,
});
const canPricingPolicy = requirePermission('pricing.policy', {
  display: { ar: 'سياسات التسعير وسعر الصرف', en: 'Pricing Policies & Exchange Rate' },
  sensitive: true,
});
const withBranchVariant = validate(branchVariantParamsSchema, 'params');

catalogRouter.get('/pricing/settings', canView, asyncHandler(pricingController.getSettings));
catalogRouter.post(
  '/pricing/exchange-rate',
  canPricingPolicy,
  validate(exchangeRateBodySchema, 'body'),
  asyncHandler(pricingController.setExchangeRate),
);
catalogRouter.put(
  '/pricing/rounding',
  canPricingPolicy,
  validate(roundingBodySchema, 'body'),
  asyncHandler(pricingController.setRounding),
);
catalogRouter.get(
  '/pricing/worklist',
  canView,
  validate(pricingViewQuerySchema, 'query'),
  asyncHandler(pricingController.getWorklist),
);
catalogRouter.post(
  '/pricing/bulk/preview',
  canPricingPolicy,
  validate(bulkPriceBodySchema, 'body'),
  asyncHandler(pricingController.previewBulk),
);
catalogRouter.post(
  '/pricing/bulk/apply',
  canPricingPolicy,
  validate(bulkPriceBodySchema, 'body'),
  asyncHandler(pricingController.applyBulk),
);
catalogRouter.get(
  '/products/:id/pricing',
  canView,
  withId,
  validate(pricingViewQuerySchema, 'query'),
  asyncHandler(pricingController.getProductPricing),
);
catalogRouter.put(
  '/variants/:id/price',
  canEditPrice,
  withId,
  validate(centralPriceBodySchema, 'body'),
  asyncHandler(pricingController.setCentralPrice),
);
catalogRouter.get('/variants/:id/price-history', canView, withId, asyncHandler(pricingController.getPriceHistory));
catalogRouter.put(
  '/branches/:branchId/variants/:variantId/price',
  canEditPrice,
  withBranchVariant,
  validate(branchPriceBodySchema, 'body'),
  asyncHandler(pricingController.setBranchPrice),
);
catalogRouter.delete(
  '/branches/:branchId/variants/:variantId/price',
  canEditPrice,
  withBranchVariant,
  asyncHandler(pricingController.clearBranchPrice),
);
catalogRouter.put(
  '/branches/:branchId/variants/:variantId/listing',
  canEditPrice,
  withBranchVariant,
  validate(listingBodySchema, 'body'),
  asyncHandler(pricingController.setListing),
);
catalogRouter.put(
  '/categories/:id/pricing-rules',
  canPricingPolicy,
  withId,
  validate(categoryPricingRulesBodySchema, 'body'),
  asyncHandler(pricingController.setCategoryRules),
);
catalogRouter.put(
  '/products/:id/pricing-rules',
  canPricingPolicy,
  withId,
  validate(productPricingRulesBodySchema, 'body'),
  asyncHandler(pricingController.setProductBand),
);
