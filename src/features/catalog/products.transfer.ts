import { and, asc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../core/db/client.js';
import { defineTransferResource } from '../../core/data-transfer/registry.js';
import type { TransferContext, TransferFilters, TransferRow } from '../../core/data-transfer/types.js';
import { ForbiddenError } from '../../core/http/api-error.js';
import { normalizeArabic } from '../../core/i18n/arabic-normalize.js';
import * as userRoleAssignmentsRepository from '../identity/repositories/user-role-assignments.repository.js';
import { catalogBrandsTable } from './schemas/brands.schema.js';
import { catalogCategoriesTable } from './schemas/categories.schema.js';
import {
  catalogAttributeValuesTable,
} from './schemas/attributes.schema.js';
import {
  catalogBarcodesTable,
  catalogProductsTable,
  catalogVariantAttributeValuesTable,
  catalogVariantUnitsTable,
  catalogVariantsTable,
} from './schemas/products.schema.js';
import { catalogUnitsTable } from './schemas/units.schema.js';
import { barcodeProblem, normalizeBarcode } from './services/barcode-rules.js';
import { importSimpleProducts, type SimpleProductImport } from './services/products.service.js';

/**
 * Products as an import/export resource (`docs/reference/app_structure.md` §٣).
 *
 * **Export: one row per variant** — the row a stock-taker or a price list needs
 * (product, variant, SKU, barcodes, unit, category path, brand, status).
 *
 * **Import: one row = one simple product** (a single variant). Variants are
 * axes chosen per category on the product screen; a spreadsheet that guessed
 * them would create combinations nobody meant. Category, brand and unit are
 * written **by name** and resolved once per file (`prepareRowSchema`), so a row
 * naming something the shop does not have is refused on its own cell.
 *
 * Guarded like the feature's own routes: reading needs `catalog.view`, writing
 * `catalog.create` — the generic transfer routes know neither.
 */

async function requirePermission(userId: number, key: string): Promise<void> {
  const keys = await userRoleAssignmentsRepository.findAllEffectivePermissionKeys(userId);
  if (!keys.includes(key)) {
    throw new ForbiddenError(`Missing required permission: ${key}`, undefined, 'permission_missing');
  }
}

const filtersSchema = z.object({ search: z.string().trim().max(150).optional() });

/** `قرطاسية / دفاتر` — the path makes a category name unambiguous on re-import. */
async function categoryPaths(): Promise<Map<number, string>> {
  const rows = await db.select().from(catalogCategoriesTable);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<number, string>();
  for (const row of rows) {
    const parts: string[] = [];
    let cur: typeof row | undefined = row;
    while (cur) {
      parts.unshift(cur.name_ar);
      cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id);
    }
    out.set(row.id, parts.join(' / '));
  }
  return out;
}

const productScope = (search: string | undefined) =>
  and(
    isNull(catalogProductsTable.archived_at),
    eq(catalogProductsTable.is_branch_draft, false),
    search
      ? or(
          ilike(catalogProductsTable.name_ar, `%${search}%`),
          ilike(catalogProductsTable.name_en, `%${search}%`),
          ilike(catalogVariantsTable.sku, `%${search}%`),
        )
      : undefined,
  );

async function countRows(search: string | undefined): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(productScope(search));
  return Number(row?.n ?? 0);
}

async function* readRows(search: string | undefined): AsyncGenerator<TransferRow> {
  const paths = await categoryPaths();
  let lastId = 0;
  for (;;) {
    const batch = await db
      .select({
        variant_id: catalogVariantsTable.id,
        product_id: catalogProductsTable.id,
        name_ar: catalogProductsTable.name_ar,
        name_en: catalogProductsTable.name_en,
        category_id: catalogProductsTable.category_id,
        brand: catalogBrandsTable.name,
        sku: catalogVariantsTable.sku,
        unit: catalogUnitsTable.name_ar,
        status: catalogProductsTable.status,
        created_at: catalogProductsTable.created_at,
      })
      .from(catalogVariantsTable)
      .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
      .leftJoin(catalogBrandsTable, eq(catalogBrandsTable.id, catalogProductsTable.brand_id))
      .innerJoin(catalogUnitsTable, eq(catalogUnitsTable.id, catalogVariantsTable.base_unit_id))
      .where(and(productScope(search), gt(catalogVariantsTable.id, lastId)))
      .orderBy(asc(catalogVariantsTable.id))
      .limit(500);
    if (batch.length === 0) return;
    const ids = batch.map((b) => b.variant_id);
    const [codes, values] = await Promise.all([
      db
        .select({ variant_id: catalogVariantUnitsTable.variant_id, code: catalogBarcodesTable.code })
        .from(catalogBarcodesTable)
        .innerJoin(catalogVariantUnitsTable, eq(catalogVariantUnitsTable.id, catalogBarcodesTable.variant_unit_id))
        .where(inArray(catalogVariantUnitsTable.variant_id, ids)),
      db
        .select({ variant_id: catalogVariantAttributeValuesTable.variant_id, value: catalogAttributeValuesTable.value_ar })
        .from(catalogVariantAttributeValuesTable)
        .innerJoin(
          catalogAttributeValuesTable,
          eq(catalogAttributeValuesTable.id, catalogVariantAttributeValuesTable.attribute_value_id),
        )
        .where(inArray(catalogVariantAttributeValuesTable.variant_id, ids)),
    ]);
    const join = (list: { variant_id: number }[], pick: (r: never) => string, id: number) =>
      list
        .filter((r) => r.variant_id === id)
        .map((r) => pick(r as never))
        .join(' | ');
    for (const b of batch) {
      yield {
        product_id: b.product_id,
        name_ar: b.name_ar,
        name_en: b.name_en,
        variant: join(values, (r: { value: string }) => r.value, b.variant_id),
        category: paths.get(b.category_id) ?? '',
        brand: b.brand,
        sku: b.sku,
        barcode: join(codes, (r: { code: string }) => r.code, b.variant_id),
        base_unit: b.unit,
        status: b.status,
        created_at: b.created_at,
      };
    }
    lastId = batch[batch.length - 1]!.variant_id;
    if (batch.length < 500) return;
  }
}

const fold = (v: string) => normalizeArabic(v).toLowerCase().replace(/\s*\/\s*/g, '/').trim();

/**
 * The row schema with the shop's names resolved — loaded once per file.
 * Messages are Arabic: they are read on the review screen, cell by cell.
 */
async function prepareRowSchema(): Promise<z.ZodTypeAny> {
  const [categories, brands, units, paths] = await Promise.all([
    db.select().from(catalogCategoriesTable).where(isNull(catalogCategoriesTable.archived_at)),
    db.select().from(catalogBrandsTable).where(isNull(catalogBrandsTable.archived_at)),
    db.select().from(catalogUnitsTable).where(eq(catalogUnitsTable.is_active, true)),
    categoryPaths(),
  ]);
  const hasChildren = new Set(categories.map((c) => c.parent_id).filter((id): id is number => id !== null));
  const leaves = categories.filter((c) => !hasChildren.has(c.id));
  const byName = new Map<string, number[]>();
  const byPath = new Map<string, number>();
  for (const c of leaves) {
    const key = fold(c.name_ar);
    byName.set(key, [...(byName.get(key) ?? []), c.id]);
    byPath.set(fold(paths.get(c.id) ?? c.name_ar), c.id);
  }
  const brandByName = new Map(brands.map((b) => [fold(b.name), b.id]));
  const unitByName = new Map<string, number>();
  for (const u of units) {
    unitByName.set(fold(u.name_ar), u.id);
    if (u.name_en) unitByName.set(fold(u.name_en), u.id);
    if (u.code) unitByName.set(fold(u.code), u.id);
  }
  const defaultUnit = units.find((u) => u.code === 'piece')?.id ?? units[0]?.id;

  return z
    .object({
      name_ar: z.string().trim().min(1, 'الاسم إلزامي').max(200),
      name_en: z.string().trim().max(200).optional(),
      category: z
        .string()
        .trim()
        .min(1, 'التصنيف إلزامي')
        .transform((v, ctx) => {
          const key = fold(v);
          const byFullPath = byPath.get(key);
          if (byFullPath) return byFullPath;
          const named = byName.get(key) ?? [];
          if (named.length === 1) return named[0]!;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              named.length > 1
                ? 'الاسم لأكثر من تصنيف — اكتب المسار «الأب / الابن» كما في التصدير'
                : 'لا تصنيف نهائي بهذا الاسم — المنتج يُوضع بأدقّ تصنيف',
          });
          return z.NEVER;
        }),
      brand: z
        .string()
        .trim()
        .optional()
        .transform((v, ctx) => {
          if (!v) return null;
          const id = brandByName.get(fold(v));
          if (id) return id;
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'لا ماركة بهذا الاسم — أضفها من الكتالوج أولاً' });
          return z.NEVER;
        }),
      base_unit: z
        .string()
        .trim()
        .optional()
        .transform((v, ctx) => {
          const id = v ? unitByName.get(fold(v)) : defaultUnit;
          if (id) return id;
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'لا وحدة بهذا الاسم' });
          return z.NEVER;
        }),
      sku: z
        .string()
        .trim()
        .max(40)
        .optional()
        .transform((v) => (v ? v.toUpperCase() : null)),
      // The same rule the product screen applies — refused here, on its cell,
      // not at commit where one typo would sink the whole file.
      barcode: z
        .string()
        .optional()
        .transform((v, ctx) => {
          if (!v || !v.trim()) return undefined;
          const code = normalizeBarcode(v);
          const problem = barcodeProblem(code);
          if (problem === null) return code;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              problem === 'checksum'
                ? 'رقم التحقق خاطئ — الأرجح أن الكود كُتب خطأً'
                : 'الباركود من ٤ إلى ٣٢: أرقام وأحرف لاتينية كبيرة وشرطة',
          });
          return z.NEVER;
        }),
      status: z.enum(['draft', 'active']).optional(),
    })
    .transform(
      (r): SimpleProductImport => ({
        name_ar: r.name_ar,
        name_en: r.name_en || null,
        category_id: r.category,
        brand_id: r.brand,
        base_unit_id: r.base_unit,
        sku: r.sku,
        barcode: r.barcode || null,
        status: r.status ?? 'draft',
      }),
    );
}

export const productsTransferResource = defineTransferResource({
  name: 'products',
  label: { ar: 'المنتجات', en: 'Products' },
  columns: [
    { key: 'product_id', label: { ar: 'رقم المنتج', en: 'Product ID' }, type: 'number', importable: false,
      hint: { ar: 'تُنشئه المنظومة', en: 'Assigned by the system' } },
    { key: 'name_ar', label: { ar: 'الاسم', en: 'Name (Arabic)' }, type: 'string', required: true,
      example: 'دفتر ٨٠ ورقة', hint: { ar: 'إلزامي', en: 'Required' } },
    { key: 'name_en', label: { ar: 'الاسم بالإنكليزية', en: 'Name (English)' }, type: 'string',
      example: 'Notebook 80 sheets', hint: { ar: 'اختياري', en: 'Optional' } },
    { key: 'variant', label: { ar: 'المتغيّر', en: 'Variant' }, type: 'string', importable: false,
      hint: { ar: 'المتغيّرات تُضاف من شاشة المنتج', en: 'Variants are added on the product screen' } },
    { key: 'category', label: { ar: 'التصنيف', en: 'Category' }, type: 'string', required: true,
      example: 'قرطاسية / دفاتر',
      hint: { ar: 'إلزامي · أدقّ تصنيف، أو المسار «الأب / الابن»', en: 'Required · the leaf, or its path' } },
    { key: 'brand', label: { ar: 'الماركة', en: 'Brand' }, type: 'string',
      hint: { ar: 'اختياري · ماركة موجودة', en: 'Optional · an existing brand' } },
    { key: 'sku', label: { ar: 'SKU', en: 'SKU' }, type: 'string',
      hint: { ar: 'اختياري · يُولَّد إن تُرك', en: 'Optional · generated when empty' } },
    { key: 'barcode', label: { ar: 'الباركود', en: 'Barcode' }, type: 'string', example: '6211234567890',
      hint: { ar: 'اختياري · لا يتكرّر', en: 'Optional · must not repeat' } },
    { key: 'base_unit', label: { ar: 'الوحدة', en: 'Unit' }, type: 'string', example: 'قطعة',
      hint: { ar: 'اختياري · «قطعة» إن تُركت', en: 'Optional · «piece» when empty' } },
    { key: 'status', label: { ar: 'الحالة', en: 'Status' }, type: 'string', example: 'draft',
      hint: { ar: 'draft (مسودة) أو active (معروض) — مسودة إن تُركت', en: 'draft or active — draft when empty' } },
    { key: 'created_at', label: { ar: 'تاريخ الإنشاء', en: 'Created at' }, type: 'datetime', importable: false,
      hint: { ar: 'تُسجّله المنظومة', en: 'Recorded by the system' } },
  ],
  filtersSchema,
  filters: [
    { key: 'search', label: { ar: 'بحث', en: 'Search' }, type: 'text',
      placeholder: { ar: 'الاسم أو SKU', en: 'Name or SKU' } },
  ],
  async authorize(ctx: TransferContext, action) {
    await requirePermission(ctx.userId, action === 'import' ? 'catalog.create' : 'catalog.view');
  },
  countRows(_ctx: TransferContext, filters: TransferFilters) {
    return countRows(filters['search'] as string | undefined);
  },
  readRows(_ctx: TransferContext, filters: TransferFilters) {
    return readRows(filters['search'] as string | undefined);
  },
  import: {
    rowSchema: z.object({}).passthrough(),
    prepareRowSchema,
    uniqueBy: ['barcode'],
    onDuplicate: 'error',
    async findExisting(_ctx: TransferContext, keys: string[]) {
      if (keys.length === 0) return new Set<string>();
      const rows = await db
        .select({ code: catalogBarcodesTable.code })
        .from(catalogBarcodesTable)
        .where(inArray(sql`lower(${catalogBarcodesTable.code})`, keys));
      return new Set(rows.map((r) => r.code.toLowerCase()));
    },
    async commit(ctx: TransferContext, rows: unknown[]) {
      const inserted = await importSimpleProducts(
        { userId: ctx.userId, ipAddress: null, deviceInfo: null, performedByRole: null, branchContext: null },
        rows as SimpleProductImport[],
      );
      return { inserted, updated: 0, skipped: 0 };
    },
  },
});
