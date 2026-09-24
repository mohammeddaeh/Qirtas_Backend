/**
 * Audited catalog actions. Same `<entity>.<verb>` convention and the same
 * `audit_log_entries` table as `features/identity/services/audit-actions.ts`,
 * written through `core/audit/audit-recorder.ts` because a feature may not
 * import another feature.
 */
export const CATALOG_AUDIT = {
  unitCreate: 'catalog.unit.create',
  unitUpdate: 'catalog.unit.update',
  attributeTypeCreate: 'catalog.attribute_type.create',
  attributeTypeUpdate: 'catalog.attribute_type.update',
  attributeTypeDelete: 'catalog.attribute_type.delete',
  attributeValueCreate: 'catalog.attribute_value.create',
  attributeValueUpdate: 'catalog.attribute_value.update',
  attributeValueDelete: 'catalog.attribute_value.delete',
  categoryCreate: 'catalog.category.create',
  categoryUpdate: 'catalog.category.update',
  categoryAttributesReplace: 'catalog.category.attributes.replace',
  categoryDelete: 'catalog.category.delete',
  categoryArchive: 'catalog.category.archive',
  categoryUnarchive: 'catalog.category.unarchive',
  brandCreate: 'catalog.brand.create',
  brandUpdate: 'catalog.brand.update',
  brandDelete: 'catalog.brand.delete',
  brandArchive: 'catalog.brand.archive',
  brandUnarchive: 'catalog.brand.unarchive',
  productCreate: 'catalog.product.create',
  productUpdate: 'catalog.product.update',
  productDelete: 'catalog.product.delete',
  productArchive: 'catalog.product.archive',
  productUnarchive: 'catalog.product.unarchive',
  variantCreate: 'catalog.variant.create',
  variantUpdate: 'catalog.variant.update',
  variantDelete: 'catalog.variant.delete',
  variantUnitsReplace: 'catalog.variant.units.replace',
  barcodeAdd: 'catalog.barcode.add',
  barcodeGenerate: 'catalog.barcode.generate',
  barcodeRemove: 'catalog.barcode.remove',
  collectionCreate: 'catalog.collection.create',
  collectionUpdate: 'catalog.collection.update',
  collectionProductsReplace: 'catalog.collection.products.replace',
  collectionDelete: 'catalog.collection.delete',
  centralPriceSet: 'catalog.price.central.set',
  branchPriceSet: 'catalog.price.branch.set',
  branchPriceClear: 'catalog.price.branch.clear',
  listingSet: 'catalog.listing.set',
  exchangeRateSet: 'catalog.pricing.exchange_rate.set',
  roundingSet: 'catalog.pricing.rounding.set',
  bulkPriceUpdate: 'catalog.pricing.bulk_update',
  categoryPricingRules: 'catalog.category.pricing_rules',
  productPricingRules: 'catalog.product.pricing_rules',
  draftCreate: 'catalog.draft.create',
  draftApprove: 'catalog.draft.approve',
  draftMerge: 'catalog.draft.merge',
  draftReject: 'catalog.draft.reject',
} as const;

/** `target_entity` values — what `EntityHistorySection(targetEntity:)` filters by. */
export const catalogTarget = {
  unit: (id: number) => `catalog_unit:${id}`,
  attributeType: (id: number) => `catalog_attribute_type:${id}`,
  attributeValue: (id: number) => `catalog_attribute_value:${id}`,
  category: (id: number) => `catalog_category:${id}`,
  brand: (id: number) => `catalog_brand:${id}`,
  product: (id: number) => `catalog_product:${id}`,
  // Barcodes and units are recorded on their variant: "what happened to this
  // variant" is the question the history section answers.
  variant: (id: number) => `catalog_variant:${id}`,
  collection: (id: number) => `catalog_collection:${id}`,
  /** Shop-wide pricing settings (rate, rounding, bulk changes) — one history for all of them. */
  pricing: () => 'catalog_pricing:settings',
} as const;
