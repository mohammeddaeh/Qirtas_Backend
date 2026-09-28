import { db } from './client.js';
import { logger } from '../logger/logger.js';
import { printOptionsTable, printSettingsTable, type PrintOptionKind } from '../../features/printing/schemas/printing.schema.js';

/**
 * خيارات الطباعة الأولى — **بنية لا أسعار**.
 *
 * الرموز يقرؤها الكود (`double` يطبع صفحتين على الورقة، و`none` هو «بلا تجليد»
 * و«بلا غلاف» — خياران يُختاران لا حقلان يُتركان)، فوجودها شرطٌ لعمل الطلب
 * أصلاً. **والأسعار لا تُبذَر**: رقمٌ مبذور يصير سعراً يُطلب من زبون بلا أن
 * يقرّره أحد — الخلية الفارغة ترفض (`print_spec_unpriced`) حتى تملأها الإدارة.
 *
 * يُدرَج ما غاب فقط، فتعديلات الإدارة (الأسماء · الترتيب · الإيقاف) تنجو من كل
 * إعادة تشغيل.
 */
const OPTIONS: { kind: PrintOptionKind; code: string; ar: string; en: string }[] = [
  { kind: 'paper_size', code: 'a4', ar: 'A4', en: 'A4' },
  { kind: 'paper_size', code: 'a5', ar: 'A5', en: 'A5' },
  { kind: 'paper_size', code: 'a3', ar: 'A3', en: 'A3' },
  { kind: 'paper_size', code: 'letter', ar: 'Letter', en: 'Letter' },
  { kind: 'color_mode', code: 'bw', ar: 'أبيض وأسود', en: 'Black & white' },
  { kind: 'color_mode', code: 'color', ar: 'ملوّن', en: 'Colour' },
  { kind: 'sides', code: 'single', ar: 'وجه واحد', en: 'Single-sided' },
  { kind: 'sides', code: 'double', ar: 'وجهان', en: 'Double-sided' },
  { kind: 'binding', code: 'none', ar: 'بلا تجليد', en: 'No binding' },
  { kind: 'binding', code: 'staple', ar: 'تدبيس', en: 'Staple' },
  { kind: 'binding', code: 'spiral', ar: 'تجليد حلزوني', en: 'Spiral' },
  { kind: 'binding', code: 'perfect', ar: 'تجليد حراري (كعب)', en: 'Perfect binding' },
  { kind: 'cover', code: 'none', ar: 'بلا غلاف', en: 'No cover' },
  { kind: 'cover', code: 'soft', ar: 'غلاف ورقي مقوّى', en: 'Soft cover' },
  { kind: 'cover', code: 'plastic', ar: 'غلاف بلاستيكي شفاف', en: 'Clear plastic cover' },
];

export async function seedPrintingReference(): Promise<void> {
  let created = 0;
  for (const [i, o] of OPTIONS.entries()) {
    const rows = await db
      .insert(printOptionsTable)
      .values({ kind: o.kind, code: o.code, name_ar: o.ar, name_en: o.en, sort_order: i })
      .onConflictDoNothing({ target: [printOptionsTable.kind, printOptionsTable.code] })
      .returning({ id: printOptionsTable.id });
    created += rows.length;
  }
  await db.insert(printSettingsTable).values({ id: 1 }).onConflictDoNothing();
  logger.info({ created }, 'Printing reference data seeded');
}
