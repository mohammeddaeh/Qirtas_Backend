import { describe, expect, it } from 'vitest';
import type {
  WireStorefrontProduct,
  WireStorefrontProductDetail,
  WireStorefrontVariant,
} from '../dtos/storefront.dto.js';

/**
 * **The server half of the storefront contract `qirtas_app` parses**
 * (`test/wire_contract_test.dart` · fixtures `test/fixtures/wire/storefront_*.json`).
 *
 * A JSON key here is an agreement nothing enforces: `tsc` does not know a
 * client exists, and the client reads a missing key as `null`. And the
 * fallback on the other side is deliberately the safe one — an unknown or
 * absent `availability` reads as «غير متوفّر بفرعك». So renaming a key does
 * not crash: **a shop full of goods quietly shows nothing for sale**, with a
 * `200` in the log and green pipelines on both halves.
 *
 * When this list changes, change the Flutter fixture in the same commit.
 */

const row: WireStorefrontProduct = {
  id: 5,
  name_ar: 'منتج تجربة مخزون',
  name_en: null,
  brand_name: null,
  category_id: 3,
  thumbnail: null,
  availability: 'available',
  price: { amount_syp: 2500, wholesale: null, was_syp: null, promotion_names: [] },
  remaining: null,
  other_branch: null,
  variant_count: 1,
};

const variant: WireStorefrontVariant = {
  variant_id: 16,
  sku: 'QRT-000016',
  label_ar: '',
  images: [],
  availability: 'available',
  price: { amount_syp: 2500, wholesale: null, was_syp: null, promotion_names: [] },
  remaining: null,
  other_branch: null,
  units: [
    { unit_id: 1, name_ar: 'قطعة', factor: 1, is_base: true, price_syp: 2500 },
    { unit_id: 2, name_ar: 'علبة', factor: 12, is_base: false, price_syp: 30000 },
  ],
};

const detail: WireStorefrontProductDetail = {
  id: 5,
  name_ar: 'منتج تجربة مخزون',
  name_en: null,
  description_ar: null,
  description_en: null,
  brand_name: null,
  category_id: 3,
  category_name_ar: 'جاف',
  images: [],
  availability: 'available',
  tax_percent: null,
  variants: [variant],
  alternatives: [],
  my_requests: [],
};

describe('the storefront wire', () => {
  it('sends a list row with exactly the keys the client reads', () => {
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'name_ar',
        'name_en',
        'brand_name',
        'category_id',
        'thumbnail',
        'availability',
        'price',
        'remaining',
        'other_branch',
        'variant_count',
      ].sort(),
    );
  });

  it('sends a product page with its variants and their units', () => {
    expect(Object.keys(detail).sort()).toEqual(
      [
        'id',
        'name_ar',
        'name_en',
        'description_ar',
        'description_en',
        'brand_name',
        'category_id',
        'category_name_ar',
        'images',
        'availability',
        'tax_percent',
        'variants',
        'alternatives',
        'my_requests',
      ].sort(),
    );
    expect(Object.keys(variant).sort()).toEqual(
      [
        'variant_id',
        'sku',
        'label_ar',
        'images',
        'availability',
        'price',
        'remaining',
        'other_branch',
        'units',
      ].sort(),
    );
    // The carton carries its own price: the client never multiplies, so
    // `factor` and `price_syp` must both travel.
    expect(Object.keys(variant.units[0]!).sort()).toEqual(
      ['unit_id', 'name_ar', 'factor', 'is_base', 'price_syp'].sort(),
    );
  });

  it('keeps the wholesale line a nested object, absent by default', () => {
    // Absent means "this buyer is not approved", and it must stay a missing
    // object rather than a zero — a zero would read as a free wholesale price.
    expect(row.price?.wholesale).toBeNull();
    const approved: WireStorefrontProduct['price'] = {
      amount_syp: 6000,
      wholesale: { amount_syp: 4800, min_qty: 12 },
      was_syp: null,
      promotion_names: [],
    };
    expect(Object.keys(approved!.wholesale!).sort()).toEqual(['amount_syp', 'min_qty'].sort());
  });

  it('carries the price before an offer, and no offer is null rather than zero', () => {
    // `was_syp: 0` would draw a struck-through «٠ ل.س» above every ordinary
    // price, and an empty `promotion_names` beside a set `was_syp` would say
    // «أرخص» without saying why — both render perfectly and mislead.
    expect(row.price?.was_syp).toBeNull();
    expect(row.price?.promotion_names).toEqual([]);
    const discounted: WireStorefrontProduct['price'] = {
      amount_syp: 4500,
      wholesale: null,
      was_syp: 6000,
      promotion_names: ['عودة المدارس'],
    };
    expect(Object.keys(discounted!).sort()).toEqual(
      ['amount_syp', 'wholesale', 'was_syp', 'promotion_names'].sort(),
    );
    // والسعر المعروض هو المدفوع — لا الأصلي مع خصمٍ يطرحه العميل.
    expect(discounted!.amount_syp).toBeLessThan(discounted!.was_syp!);
  });
});
