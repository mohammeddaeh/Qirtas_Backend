import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { mediaAssetsTable } from '../../../core/media/schemas/media-assets.schema.js';
import { DOCUMENT_KINDS } from '../dtos/layout.schema.js';

/**
 * الفواتير والملصقات — `docs/reference/receipts_labels.md`.
 *
 * **ملف المحل صفٌّ واحد** (`id = 1`): الاسم والشعار والرقم الضريبي هي ما
 * يطبعه كل فرع، وبيانات الفرع نفسه (العنوان والتواصل) تُقرأ من جدول الفروع
 * لا تُنسخ هنا — نسخةٌ ثانية منها تبقى على العنوان القديم يوم ينتقل الفرع.
 */
export const businessProfileTable = pgTable('business_profile', {
  id: smallint('id').primaryKey(),
  name_ar: varchar('name_ar', { length: 120 }).notNull(),
  name_en: varchar('name_en', { length: 120 }),
  logo_media_id: integer('logo_media_id').references(() => mediaAssetsTable.id, {
    onDelete: 'set null',
  }),
  tax_number: varchar('tax_number', { length: 40 }),
  commercial_register: varchar('commercial_register', { length: 40 }),
  updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentKindEnum = pgEnum('document_kind', DOCUMENT_KINDS);

/**
 * القوالب. **`layout` JSON يتحقّق منه الخادم** (`dtos/layout.schema.ts`) ويُخزَّن
 * بكل قيمه الافتراضية مملوءة، فالعميل يقرأ دائماً شكلاً كاملاً.
 *
 * **الجاهز (`is_system`) لا يُعدَّل ولا يُحذف — يُنسخ**: الأصل يبقى مكاناً
 * يُرجَع إليه بعد تعديلٍ أفسد الشكل. و`code` معرّفه الثابت الذي تُحدِّثه البذرة.
 *
 * **قالبٌ افتراضي واحد لكل نوع** — فهرس فريد جزئي، فلا يستطيع خطأ بالخدمة أن
 * يترك فاتورتين افتراضيتين يختار بينهما الجهاز بلا قاعدة.
 *
 * **والحذف فعلي**: لا شيء يشير إلى قالب — الفاتورة لا تحفظ أيّ قالب طُبعت به
 * (تُطبع اليوم بالقالب الحالي)، والتدقيق يحفظ القصة.
 */
export const documentTemplatesTable = pgTable(
  'document_templates',
  {
    id: serial('id').primaryKey(),
    code: varchar('code', { length: 40 }),
    kind: documentKindEnum('kind').notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    layout: jsonb('layout').$type<Record<string, unknown>>().notNull(),
    is_default: boolean('is_default').notNull().default(false),
    is_system: boolean('is_system').notNull().default(false),
    created_by: integer('created_by').references(() => usersTable.id, { onDelete: 'set null' }),
    updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeUnique: uniqueIndex('document_templates_code_uq').on(table.code),
    oneDefaultPerKind: uniqueIndex('document_templates_default_uq')
      .on(table.kind)
      .where(sql`${table.is_default}`),
  }),
);

export type BusinessProfileRow = typeof businessProfileTable.$inferSelect;
export type DocumentTemplateRow = typeof documentTemplatesTable.$inferSelect;
export type NewDocumentTemplateRow = typeof documentTemplatesTable.$inferInsert;
