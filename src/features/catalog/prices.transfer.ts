import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../core/db/client.js';
import { defineTransferResource } from '../../core/data-transfer/registry.js';
import type { TransferContext, TransferRow } from '../../core/data-transfer/types.js';
import { ForbiddenError } from '../../core/http/api-error.js';
import { holdsPermissionAt } from '../../core/http/require-permission.js';
import * as userRoleAssignmentsRepository from '../identity/repositories/user-role-assignments.repository.js';
import {
  catalogBarcodesTable,
  catalogProductsTable,
  catalogVariantUnitsTable,
  catalogVariantsTable,
} from './schemas/products.schema.js';
import { catalogVariantPricesTable } from './schemas/pricing.schema.js';
import { catalogUnitsTable } from './schemas/units.schema.js';
import { importCentralPrices, type CentralPriceImport } from './services/pricing.service.js';

/**
 * **Central prices as a spreadsheet** (2026-10-11, app_structure.md slice د).
 *
 * Export the price list, change what changed, import it back. One row per
 * item: retail price, currency, and the optional wholesale price and minimum.
 * **Central prices only** — a branch's price depends on that product's pricing
 * policy (locked, free, banded), and a file cannot say which rule a cell is
 * written under; branch prices stay on the product's pricing screen.
 *
 * A row with no price is skipped (an item not priced yet stays so), and a row
 * equal to what is stored is skipped by the service — so the file sent back
 * whole writes only what moved.
 *
 * Export needs `catalog.view`; import needs `pricing.edit` **for every branch**,
 * the same rule as the central price on the product screen.
 */

async function requirePermission(userId: number, key: string): Promise<void> {
  const keys = await userRoleAssignmentsRepository.findAllEffectivePermissionKeys(userId);
  if (!keys.includes(key)) {
    throw new ForbiddenError(`Missing required permission: ${key}`, undefined, 'permission_missing');
  }
}

const variantScope = and(isNull(catalogProductsTable.archived_at));

async function countRows(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(variantScope);
  return Number(row?.n ?? 0);
}

async function* readRows(): AsyncGenerator<TransferRow> {
  let lastId = 0;
  for (;;) {
    const batch = await db
      .select({
        id: catalogVariantsTable.id,
        sku: catalogVariantsTable.sku,
        name: catalogProductsTable.name_ar,
        unit: catalogUnitsTable.name_ar,
        amount: catalogVariantPricesTable.amount,
        currency: catalogVariantPricesTable.currency,
        wholesale: catalogVariantPricesTable.wholesale_amount,
        min_qty: catalogVariantPricesTable.wholesale_min_qty,
      })
      .from(catalogVariantsTable)
      .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
      .innerJoin(catalogUnitsTable, eq(catalogUnitsTable.id, catalogVariantsTable.base_unit_id))
      .leftJoin(catalogVariantPricesTable, eq(catalogVariantPricesTable.variant_id, catalogVariantsTable.id))
      .where(and(variantScope, gt(catalogVariantsTable.id, lastId)))
      .orderBy(asc(catalogVariantsTable.id))
      .limit(500);
    if (batch.length === 0) return;
    for (const b of batch) {
      yield {
        code: b.sku,
        name: b.name,
        unit: b.unit,
        currency: b.currency ?? '',
        price: b.amount === null ? null : Number(b.amount),
        wholesale_price: b.wholesale === null ? null : Number(b.wholesale),
        wholesale_min_qty: b.min_qty === null ? null : Number(b.min_qty),
      };
    }
    lastId = batch[batch.length - 1]!.id;
    if (batch.length < 500) return;
  }
}

/** Marks a row the shop left without a price — skipped at commit. */
type PriceRow = CentralPriceImport & { skip: boolean };

async function prepareRowSchema(): Promise<z.ZodTypeAny> {
  const [variants, codes] = await Promise.all([
    db
      .select({ id: catalogVariantsTable.id, sku: catalogVariantsTable.sku })
      .from(catalogVariantsTable)
      .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
      .where(variantScope),
    db
      .select({ code: catalogBarcodesTable.code, variant_id: catalogVariantUnitsTable.variant_id })
      .from(catalogBarcodesTable)
      .innerJoin(catalogVariantUnitsTable, eq(catalogVariantUnitsTable.id, catalogBarcodesTable.variant_unit_id)),
  ]);
  const bySku = new Map(variants.map((v) => [v.sku.toUpperCase(), v.id]));
  const live = new Set(variants.map((v) => v.id));
  const owners = new Map<string, Set<number>>();
  for (const c of codes) {
    const key = c.code.toUpperCase();
    owners.set(key, (owners.get(key) ?? new Set()).add(c.variant_id));
  }
  // The engine has already typed number columns (`parseCell`); text may still
  // arrive from the grid.
  const amount = (label: string, allowZero: boolean) =>
    z
      .union([z.number(), z.string()])
      .optional()
      .transform((v, ctx) => {
        const n = typeof v === 'number' ? v : (v ?? '').trim() === '' ? null : Number((v ?? '').replace(/,/g, ''));
        if (n === null) return null;
        if (Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) && n <= 1_000_000_000) return n;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: label });
        return z.NEVER;
      });

  return z
    .object({
      code: z
        .string()
        .trim()
        .min(1, 'SKU أو الباركود إلزامي')
        .transform((v, ctx) => {
          const key = v.toUpperCase();
          const sku = bySku.get(key);
          if (sku) return sku;
          const found = [...(owners.get(key) ?? [])].filter((id) => live.has(id));
          if (found.length === 1) return found[0]!;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: found.length > 1 ? 'باركود مشترك بين أكثر من صنف — اكتب SKU' : 'لا صنف بهذا SKU أو الباركود',
          });
          return z.NEVER;
        }),
      currency: z
        .string()
        .optional()
        .transform((v, ctx) => {
          const t = (v ?? '').trim().toUpperCase();
          if (t === '') return null;
          if (t === 'SYP' || t === 'USD') return t;
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'العملة SYP أو USD — أو اتركها' });
          return z.NEVER;
        }),
      price: amount('السعر رقمٌ موجب', false),
      wholesale_price: amount('سعر الجملة رقمٌ لا يقلّ عن صفر', true),
      wholesale_min_qty: amount('أقلّ كمية للجملة رقمٌ موجب', false),
    })
    .superRefine((r, ctx) => {
      if (r.price === null) return;
      if (r.wholesale_price !== null && r.wholesale_price >= r.price) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['wholesale_price'], message: 'سعر الجملة أقلّ من سعر التجزئة' });
      }
    })
    .transform(
      (r): PriceRow => ({
        skip: r.price === null,
        variant_id: r.code,
        amount: r.price ?? 0,
        currency: r.currency,
        wholesale_amount: r.wholesale_price,
        wholesale_min_qty: r.wholesale_min_qty,
      }),
    );
}

export const pricesTransferResource = defineTransferResource({
  name: 'prices',
  label: { ar: 'الأسعار المركزية', en: 'Central prices' },
  columns: [
    { key: 'code', label: { ar: 'SKU أو الباركود', en: 'SKU or barcode' }, type: 'string', required: true,
      example: 'NB-80', hint: { ar: 'إلزامي', en: 'Required' } },
    { key: 'name', label: { ar: 'الصنف', en: 'Item' }, type: 'string', importable: false,
      hint: { ar: 'للقراءة — من الكتالوج', en: 'For reference — from the catalogue' } },
    { key: 'unit', label: { ar: 'وحدة الأساس', en: 'Base unit' }, type: 'string', importable: false,
      hint: { ar: 'السعر لهذه الوحدة', en: 'The price is for this unit' } },
    { key: 'currency', label: { ar: 'العملة', en: 'Currency' }, type: 'string', example: 'SYP',
      hint: { ar: 'SYP أو USD — فارغة: كما هي أو حسب التصنيف', en: 'SYP or USD — empty: as stored, or the category\'s' } },
    { key: 'price', label: { ar: 'سعر التجزئة', en: 'Retail price' }, type: 'number', example: '2500',
      hint: { ar: 'السطر بلا سعر يُتخطّى', en: 'Rows without a price are skipped' } },
    { key: 'wholesale_price', label: { ar: 'سعر الجملة', en: 'Wholesale price' }, type: 'number',
      hint: { ar: 'اختياري · أقلّ من التجزئة · فارغ يمسحه', en: 'Optional · below retail · empty clears it' } },
    { key: 'wholesale_min_qty', label: { ar: 'أقلّ كمية للجملة', en: 'Wholesale minimum' }, type: 'number',
      hint: { ar: 'اختياري · فارغ: حسب التصنيف', en: 'Optional · empty: the category\'s' } },
  ],
  filtersSchema: z.object({}),
  filters: [],
  async authorize(ctx: TransferContext, action) {
    if (action === 'export') return requirePermission(ctx.userId, 'catalog.view');
    // The central price is written for every branch at once.
    if (!(await holdsPermissionAt(ctx.userId, 'pricing.edit', null))) {
      throw new ForbiddenError('Central prices need pricing.edit for every branch', undefined, 'price_central_only');
    }
  },
  countRows() {
    return countRows();
  },
  readRows() {
    return readRows();
  },
  import: {
    rowSchema: z.object({}).passthrough(),
    prepareRowSchema,
    uniqueBy: ['code'],
    onDuplicate: 'error',
    async commit(ctx: TransferContext, rows: unknown[]) {
      const all = rows as PriceRow[];
      const live = all.filter((r) => !r.skip);
      const result = await importCentralPrices(
        {
          userId: ctx.userId,
          ipAddress: null,
          deviceInfo: null,
          performedByRole: null,
          branchContext: null,
          stationId: ctx.stationId ?? null,
        },
        live,
      );
      return { ...result, skipped: result.skipped + (all.length - live.length) };
    },
  },
});


