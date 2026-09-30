import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { logger } from '../logger/logger.js';
import {
  businessProfileTable,
  documentTemplatesTable,
} from '../../features/documents/schemas/documents.schema.js';
import {
  labelLayoutSchema,
  receiptLayoutSchema,
  type DocumentKind,
} from '../../features/documents/dtos/layout.schema.js';

/**
 * القوالب الجاهزة — `docs/reference/receipts_labels.md` §القوالب الجاهزة.
 *
 * **تمرّ بمخطط التحقق نفسه** الذي يمرّ به ما تحفظه الإدارة: قالبٌ مبذور بقيمة
 * خارج النطاق يُفشل البذرة بصوت عالٍ بدل أن يُشحن شكلاً يرفضه الخادم عند أول
 * نسخ له.
 *
 * **والجاهز يُحدَّث بكل بذرة** (بخلاف الخيارات والأسماء التي يعدّلها الناس):
 * لا أحد يستطيع تعديله — يُنسخ ثم يُعدَّل النسخة — فتحديثه هنا لا يدهس عمل
 * أحد، وتحسينُ شكلٍ جاهز يصل كل تثبيت. والافتراضي لا يُمسّ بعد أول بذرة:
 * اختيارُ الإدارة قالباً آخر قرارٌ يجب أن ينجو من إعادة التشغيل.
 */

const RECEIPT_BLOCKS_CLASSIC = [
  { type: 'logo', align: 'center' },
  { type: 'shop_name', align: 'center', size: 'large' },
  { type: 'branch_info', align: 'center', size: 'small' },
  { type: 'tax_info', align: 'center' },
  // المسافة تفصل لا الخطوط: عنوان «فاتورة» ورأس الأصناف وإطار الإجمالي فواصل
  // أصلاً (يرسمها المُصيِّر)، وخطٌّ منقّط فوق كلٍّ منها كان يزحم الفاتورة.
  { type: 'spacer', height_mm: 2 },
  { type: 'sale_meta' },
  { type: 'lines', style: 'detailed' },
  { type: 'totals' },
  { type: 'payment' },
  { type: 'spacer', height_mm: 4 },
  { type: 'sale_barcode' },
  { type: 'text', align: 'center', text_ar: 'شكراً لزيارتكم', text_en: 'Thank you for your visit' },
];

const TEMPLATES: { code: string; kind: DocumentKind; name: string; isDefault: boolean; layout: unknown }[] = [
  {
    code: 'receipt_classic',
    kind: 'receipt',
    name: 'كلاسيكية (رول ٨٠)',
    isDefault: true,
    layout: { page: { paper: 'roll_80' }, blocks: RECEIPT_BLOCKS_CLASSIC },
  },
  // ── الأنماط الخمسة الأخرى (2026-09-29) — الأقسام نفسها تقريباً، والرسم
  // يختلف بـ`page.style`. كل محل ينسخ ما يعجبه ويعدّل الكثافة والإجمالي
  // والفواصل وخط العناوين فوقه.
  {
    code: 'receipt_modern',
    kind: 'receipt',
    name: 'عصرية (رول ٨٠)',
    isDefault: false,
    layout: {
      page: { paper: 'roll_80', style: 'modern' },
      blocks: [
        { type: 'shop_name', align: 'center', size: 'large' },
        { type: 'branch_info', align: 'center', size: 'small' },
        { type: 'sale_meta' },
        { type: 'lines', style: 'detailed' },
        { type: 'totals' },
        { type: 'payment' },
        { type: 'spacer', height_mm: 3 },
        { type: 'sale_barcode' },
        { type: 'text', align: 'center', size: 'small', text_ar: 'شكراً لزيارتكم', text_en: 'Thank you' },
      ],
    },
  },
  {
    code: 'receipt_minimal',
    kind: 'receipt',
    name: 'بسيطة (رول ٨٠)',
    isDefault: false,
    layout: {
      page: { paper: 'roll_80', style: 'minimal' },
      blocks: [
        { type: 'shop_name', align: 'start' },
        { type: 'sale_meta', show_cashier: false, show_customer: false },
        { type: 'lines', style: 'compact' },
        { type: 'totals', show_subtotal: false, show_tax: false },
        { type: 'payment' },
        { type: 'text', align: 'center', size: 'small', text_ar: 'شكراً', text_en: 'Thanks' },
      ],
    },
  },
  {
    code: 'receipt_tabular',
    kind: 'receipt',
    name: 'جدولية (رول ٨٠)',
    isDefault: false,
    layout: {
      page: { paper: 'roll_80', style: 'tabular' },
      blocks: [
        { type: 'logo', align: 'center' },
        { type: 'shop_name', align: 'center' },
        { type: 'branch_info', align: 'center', size: 'small' },
        { type: 'tax_info', align: 'center' },
        { type: 'sale_meta' },
        { type: 'lines', style: 'detailed' },
        { type: 'totals' },
        { type: 'payment' },
        { type: 'spacer', height_mm: 3 },
        { type: 'sale_barcode' },
      ],
    },
  },
  {
    code: 'receipt_elegant',
    kind: 'receipt',
    name: 'أنيقة (رول ٨٠)',
    isDefault: false,
    layout: {
      page: { paper: 'roll_80', style: 'elegant' },
      blocks: [
        { type: 'shop_name', align: 'center', size: 'xlarge' },
        { type: 'branch_info', align: 'center', size: 'small', show_contact: false },
        { type: 'sale_meta', show_cashier: false },
        { type: 'lines', style: 'detailed' },
        { type: 'totals' },
        { type: 'payment' },
        { type: 'text', align: 'center', text_ar: 'شكراً لزيارتكم', text_en: 'Thank you for your visit' },
      ],
    },
  },
  {
    code: 'receipt_ticket',
    kind: 'receipt',
    name: 'تذكرة (رول ٨٠)',
    isDefault: false,
    layout: {
      page: { paper: 'roll_80', style: 'ticket' },
      blocks: [
        { type: 'sale_meta' },
        { type: 'lines', style: 'compact' },
        { type: 'totals', show_subtotal: false },
        { type: 'payment' },
        { type: 'spacer', height_mm: 3 },
        { type: 'sale_barcode' },
      ],
    },
  },
  {
    code: 'receipt_compact',
    kind: 'receipt',
    name: 'مختصرة (رول ٥٨)',
    isDefault: false,
    layout: {
      page: { paper: 'roll_58', margin_mm: 1, font_scale: 0.9 },
      blocks: [
        { type: 'shop_name', align: 'center' },
        { type: 'branch_info', align: 'center', size: 'small', show_address: false },
        { type: 'sale_meta', show_cashier: false },
        { type: 'lines', style: 'compact', show_unit_price: false, show_discount: false },
        { type: 'spacer', height_mm: 2 },
        { type: 'totals', show_subtotal: false },
        { type: 'payment', show_method: false },
        { type: 'text', align: 'center', size: 'small', text_ar: 'شكراً لزيارتكم' },
      ],
    },
  },
  {
    code: 'receipt_detailed',
    kind: 'receipt',
    name: 'مفصّلة ثنائية اللغة (A4)',
    isDefault: false,
    layout: {
      page: { paper: 'a4', margin_mm: 12, language: 'both' },
      blocks: [
        { type: 'logo', align: 'start', height_mm: 18 },
        { type: 'shop_name', align: 'start', size: 'xlarge' },
        { type: 'branch_info', align: 'start' },
        { type: 'tax_info', align: 'start', show_commercial_register: true },
        { type: 'spacer', height_mm: 4 },
        { type: 'sale_meta' },
        { type: 'spacer', height_mm: 2 },
        { type: 'lines', style: 'detailed', show_sku: true },
        { type: 'divider', style: 'solid' },
        { type: 'totals', total_size: 'xlarge' },
        { type: 'payment' },
        { type: 'spacer', height_mm: 6 },
        { type: 'qr', align: 'end' },
        {
          type: 'text',
          align: 'center',
          size: 'small',
          text_ar: 'الأسعار شاملة الضريبة',
          text_en: 'Prices include VAT',
        },
      ],
    },
  },
  {
    code: 'label_shelf',
    kind: 'label',
    name: 'سعر رف (٥٠×٣٠)',
    isDefault: true,
    layout: {
      page: { width_mm: 50, height_mm: 30, medium: { mode: 'label_roll' } },
      blocks: [
        { type: 'product_name', size: 'normal', max_lines: 2 },
        { type: 'variant' },
        { type: 'price', align: 'center' },
        { type: 'barcode', height_mm: 8 },
      ],
    },
  },
  {
    code: 'label_product',
    kind: 'label',
    name: 'ملصق منتج (٤٠×٢٥)',
    isDefault: false,
    layout: {
      page: { width_mm: 40, height_mm: 25, medium: { mode: 'label_roll' } },
      blocks: [
        { type: 'shop_name', align: 'center', size: 'small' },
        { type: 'product_name', align: 'center', size: 'small', max_lines: 1 },
        { type: 'barcode', height_mm: 9 },
      ],
    },
  },
  {
    code: 'label_small',
    kind: 'label',
    name: 'صغير (٣٠×٢٠)',
    isDefault: false,
    layout: {
      page: { width_mm: 30, height_mm: 20, margin_mm: 0.5, font_scale: 0.9, medium: { mode: 'label_roll' } },
      blocks: [
        { type: 'price', align: 'center', size: 'large', show_before: false, show_currency: false },
        { type: 'barcode', height_mm: 7, show_digits: false },
      ],
    },
  },
  {
    code: 'label_sheet_a4',
    kind: 'label',
    name: 'ورقة A4 (٣×٨)',
    isDefault: false,
    layout: {
      page: {
        width_mm: 70,
        height_mm: 37,
        margin_mm: 2,
        medium: { mode: 'sheet', sheet: 'a4', columns: 3, rows: 8 },
      },
      blocks: [
        { type: 'product_name', max_lines: 2 },
        { type: 'variant' },
        { type: 'price', size: 'large' },
        { type: 'barcode', height_mm: 9 },
      ],
    },
  },
];

export async function seedDocumentTemplates(): Promise<void> {
  await db
    .insert(businessProfileTable)
    .values({ id: 1, name_ar: 'قرطاس', name_en: 'Qirtas' })
    .onConflictDoNothing({ target: businessProfileTable.id });

  // Defaults are claimed only for a kind that has none yet — never moved.
  const defaults = await db
    .select({ kind: documentTemplatesTable.kind })
    .from(documentTemplatesTable)
    .where(eq(documentTemplatesTable.is_default, true));
  const claimed = new Set(defaults.map((r) => r.kind));

  for (const t of TEMPLATES) {
    const layout = (t.kind === 'receipt' ? receiptLayoutSchema : labelLayoutSchema).parse(t.layout);
    await db
      .insert(documentTemplatesTable)
      .values({
        code: t.code,
        kind: t.kind,
        name: t.name,
        layout,
        is_system: true,
        is_default: t.isDefault && !claimed.has(t.kind),
      })
      .onConflictDoUpdate({
        target: documentTemplatesTable.code,
        set: { name: t.name, layout, updated_at: new Date() },
      });
    if (t.isDefault) claimed.add(t.kind);
  }
  logger.info({ templates: TEMPLATES.length }, 'Document templates seeded');
}
