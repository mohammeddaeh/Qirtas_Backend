import { describe, expect, it } from 'vitest';
import type { WireDocumentContext, WireLabelItem } from '../dtos/documents.dto.js';
import { receiptLayoutSchema } from '../dtos/layout.schema.js';

/**
 * **The server half of the documents contract `qirtas_app` parses**
 * (`test/wire_contract_test.dart` · fixtures `test/fixtures/wire/document_*.json`).
 *
 * A renamed key here does not crash the app: the renderer reads a missing
 * option as its default and a missing price as «غير مسعَّر». The receipt
 * prints — just not the one the administration designed.
 *
 * When this list changes, change the Flutter fixtures in the same commit.
 */

const context: WireDocumentContext = {
  profile: {
    name_ar: 'قرطاس',
    name_en: 'Qirtas',
    logo: null,
    tax_number: '123456',
    commercial_register: null,
    updated_at: '2026-09-29T00:00:00.000Z',
  },
  branch: { id: 1, name: 'الفرع الرئيسي', address: 'دمشق', contact_info: '0110000000' },
  receipt_template: {
    id: 1,
    code: 'receipt_classic',
    kind: 'receipt',
    name: 'كلاسيكية (رول ٨٠)',
    is_default: true,
    is_system: true,
    layout: receiptLayoutSchema.parse({ page: { paper: 'roll_80' }, blocks: [{ type: 'totals' }] }),
    updated_at: '2026-09-29T00:00:00.000Z',
  },
  label_template: null,
  job_tag_template: null,
};

const label: WireLabelItem = {
  variant_id: 16,
  product_id: 5,
  unit_id: 2,
  unit_name_ar: 'علبة',
  unit_factor: 12,
  name_ar: 'قلم',
  name_en: null,
  variant_label_ar: 'أزرق',
  sku: 'QRT-000016',
  barcode: '6281000000001',
  price: { status: 'priced', amount_syp: 30000, was_syp: 36000, promotion_names: ['عودة المدارس'] },
};

describe('documents wire contract', () => {
  it('context carries the keys the app reads', () => {
    expect(Object.keys(context).sort()).toEqual(['branch', 'job_tag_template', 'label_template', 'profile', 'receipt_template']);
    expect(Object.keys(context.profile).sort()).toEqual([
      'commercial_register',
      'logo',
      'name_ar',
      'name_en',
      'tax_number',
      'updated_at',
    ]);
    expect(Object.keys(context.receipt_template!).sort()).toEqual([
      'code',
      'id',
      'is_default',
      'is_system',
      'kind',
      'layout',
      'name',
      'updated_at',
    ]);
  });

  it('a stored layout carries version, page and blocks', () => {
    expect(Object.keys(context.receipt_template!.layout).sort()).toEqual(['blocks', 'page', 'version']);
  });

  it('a label carries its price inside `price`, never a bare amount', () => {
    expect(Object.keys(label).sort()).toEqual([
      'barcode',
      'name_ar',
      'name_en',
      'price',
      'product_id',
      'sku',
      'unit_factor',
      'unit_id',
      'unit_name_ar',
      'variant_id',
      'variant_label_ar',
    ]);
    expect(Object.keys(label.price).sort()).toEqual(['amount_syp', 'promotion_names', 'status', 'was_syp']);
  });
});
