import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../core/db/client.js';
import { defineTransferResource } from '../../core/data-transfer/registry.js';
import type { TransferContext, TransferFilters, TransferRow } from '../../core/data-transfer/types.js';
import { ForbiddenError } from '../../core/http/api-error.js';
import { normalizeArabic } from '../../core/i18n/arabic-normalize.js';
import * as userRoleAssignmentsRepository from '../identity/repositories/user-role-assignments.repository.js';
import { branchesTable } from '../identity/schemas/branches.schema.js';
import {
  catalogBarcodesTable,
  catalogProductsTable,
  catalogVariantUnitsTable,
  catalogVariantsTable,
} from '../catalog/schemas/products.schema.js';
import { catalogUnitsTable } from '../catalog/schemas/units.schema.js';
import { stockBalancesTable } from './schemas/stock.schema.js';
import { suppliersTable } from './schemas/suppliers.schema.js';
import { createReceipt } from './services/receipts.service.js';

/**
 * **The opening balance** — what is on the shelves the day the shop starts
 * using the system (2026-10-11, app_structure.md slice د).
 *
 * Counted once in a spreadsheet and imported, instead of typed item by item in
 * every branch. **It is written as receipts** from a system supplier named
 * «رصيد افتتاحي», not as a raw number: that keeps the one path every unit of
 * stock enters by — a movement, a cost layer, a numbered document, an audit
 * line — so the balance can be rebuilt from the ledger and the average cost is
 * right from the first sale. Receipts post no money, so nothing appears as a
 * purchase in the reports.
 *
 * **Only for an item with no history in that branch.** A row whose item already
 * has a balance there is refused on its cell: a second «opening» would add to a
 * real count, and the answer to a wrong balance is a stock count, not another
 * import. A row with no quantity is skipped, so the exported list can be
 * filled and sent back without deleting the rows the branch does not hold.
 *
 * Guarded like the feature's routes: export `inventory.view`, import
 * `inventory.receive`.
 */

async function requirePermission(userId: number, key: string): Promise<void> {
  const keys = await userRoleAssignmentsRepository.findAllEffectivePermissionKeys(userId);
  if (!keys.includes(key)) {
    throw new ForbiddenError(`Missing required permission: ${key}`, undefined, 'permission_missing');
  }
}

/** The system supplier the opening receipts are written against — made once. */
export const OPENING_STOCK_SUPPLIER_KEY = 'opening_stock';

async function openingSupplierId(): Promise<number> {
  const [found] = await db
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(eq(suppliersTable.system_key, OPENING_STOCK_SUPPLIER_KEY))
    .limit(1);
  if (found) return found.id;
  const name = 'رصيد افتتاحي';
  const [made] = await db
    .insert(suppliersTable)
    .values({ name, search_text: normalizeArabic(name).toLowerCase(), system_key: OPENING_STOCK_SUPPLIER_KEY })
    .onConflictDoNothing()
    .returning({ id: suppliersTable.id });
  if (made) return made.id;
  // Lost a race with another import: the row exists now.
  return openingSupplierId();
}

const fold = (v: string) => normalizeArabic(v).toLowerCase().trim();

async function liveBranches() {
  return db
    .select({ id: branchesTable.id, code: branchesTable.code, name: branchesTable.name, name_en: branchesTable.name_en })
    .from(branchesTable)
    .where(isNull(branchesTable.archived_at));
}

const filtersSchema = z.object({ branch: z.string().trim().max(150).optional() });

const variantScope = and(isNull(catalogProductsTable.archived_at));

async function countRows(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(variantScope);
  return Number(row?.n ?? 0);
}

/**
 * One row per item. With a branch filter, the branch is filled in and so is
 * what it holds now (`on_hand` is read-only, for reference); without one, the
 * branch column is left for the counter to fill.
 */
async function* readRows(branchFilter: string | undefined): AsyncGenerator<TransferRow> {
  const branches = await liveBranches();
  const branch = branchFilter
    ? branches.find((b) => b.code.toUpperCase() === branchFilter.toUpperCase() || fold(b.name) === fold(branchFilter))
    : undefined;
  let lastId = 0;
  for (;;) {
    const batch = await db
      .select({
        variant_id: catalogVariantsTable.id,
        sku: catalogVariantsTable.sku,
        name_ar: catalogProductsTable.name_ar,
        unit: catalogUnitsTable.name_ar,
      })
      .from(catalogVariantsTable)
      .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
      .innerJoin(catalogUnitsTable, eq(catalogUnitsTable.id, catalogVariantsTable.base_unit_id))
      .where(and(variantScope, gt(catalogVariantsTable.id, lastId)))
      .orderBy(asc(catalogVariantsTable.id))
      .limit(500);
    if (batch.length === 0) return;
    const balances = branch
      ? await db
          .select({ variant_id: stockBalancesTable.variant_id, on_hand: stockBalancesTable.on_hand })
          .from(stockBalancesTable)
          .where(
            and(
              eq(stockBalancesTable.branch_id, branch.id),
              inArray(
                stockBalancesTable.variant_id,
                batch.map((b) => b.variant_id),
              ),
            ),
          )
      : [];
    for (const b of batch) {
      const held = balances.find((x) => x.variant_id === b.variant_id);
      yield {
        branch: branch?.code ?? '',
        code: b.sku,
        name: b.name_ar,
        unit: b.unit,
        on_hand: held ? Number(held.on_hand) : null,
        qty: null,
        unit_cost: null,
        expires_at: null,
      };
    }
    lastId = batch[batch.length - 1]!.variant_id;
    if (batch.length < 500) return;
  }
}

export interface OpeningStockRow {
  /** A row the counter left empty — skipped at commit, counted as skipped. */
  skip: boolean;
  branch_id: number;
  variant_id: number;
  unit_id: number;
  qty: number;
  unit_cost: number;
  expires_at: string | null;
}

/** The names resolved once per file; messages are Arabic (read cell by cell). */
async function prepareRowSchema(): Promise<z.ZodTypeAny> {
  const [branches, variants, codes, balances] = await Promise.all([
    liveBranches(),
    db
      .select({ id: catalogVariantsTable.id, sku: catalogVariantsTable.sku, unit_id: catalogVariantsTable.base_unit_id })
      .from(catalogVariantsTable)
      .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
      .where(variantScope),
    db
      .select({ code: catalogBarcodesTable.code, variant_id: catalogVariantUnitsTable.variant_id })
      .from(catalogBarcodesTable)
      .innerJoin(catalogVariantUnitsTable, eq(catalogVariantUnitsTable.id, catalogBarcodesTable.variant_unit_id)),
    db
      .select({ branch_id: stockBalancesTable.branch_id, variant_id: stockBalancesTable.variant_id })
      .from(stockBalancesTable),
  ]);
  const branchBy = new Map<string, number>();
  for (const b of branches) {
    branchBy.set(b.code.toUpperCase(), b.id);
    branchBy.set(fold(b.name), b.id);
    if (b.name_en) branchBy.set(fold(b.name_en), b.id);
  }
  const variantBySku = new Map(variants.map((v) => [v.sku.toUpperCase(), v]));
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const codeOwners = new Map<string, Set<number>>();
  for (const c of codes) {
    const key = c.code.toUpperCase();
    codeOwners.set(key, (codeOwners.get(key) ?? new Set()).add(c.variant_id));
  }
  const held = new Set(balances.map((b) => `${b.branch_id}:${b.variant_id}`));
  // The engine has already typed the cell by its column (`parseCell`): a number
  // column arrives as a number, a date column as a Date, an empty cell absent.
  const number = (v: number | string | undefined) => {
    if (typeof v === 'number') return v;
    const t = (v ?? '').trim().replace(/,/g, '');
    return t === '' ? null : Number(t);
  };

  return z
    .object({
      branch: z
        .string()
        .trim()
        .min(1, 'الفرع إلزامي — رمزه أو اسمه')
        .transform((v, ctx) => {
          const id = branchBy.get(v.toUpperCase()) ?? branchBy.get(fold(v));
          if (id) return id;
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'لا فرع بهذا الرمز أو الاسم' });
          return z.NEVER;
        }),
      code: z
        .string()
        .trim()
        .min(1, 'SKU أو الباركود إلزامي')
        .transform((v, ctx) => {
          const key = v.toUpperCase();
          const bySku = variantBySku.get(key);
          if (bySku) return bySku;
          const owners = [...(codeOwners.get(key) ?? [])];
          if (owners.length === 1 && variantById.has(owners[0]!)) return variantById.get(owners[0]!)!;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: owners.length > 1 ? 'باركود مشترك بين أكثر من صنف — اكتب SKU' : 'لا صنف بهذا SKU أو الباركود',
          });
          return z.NEVER;
        }),
      qty: z
        .union([z.number(), z.string()])
        .optional()
        .transform((v, ctx) => {
          const n = number(v);
          if (n === null || n === 0) return 0;
          if (Number.isFinite(n) && n > 0 && n <= 10_000_000) return Number(n.toFixed(3));
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'الكمية رقمٌ موجب بوحدة الأساس' });
          return z.NEVER;
        }),
      unit_cost: z
        .union([z.number(), z.string()])
        .optional()
        .transform((v, ctx) => {
          const n = number(v);
          if (n === null) return null;
          if (Number.isFinite(n) && n >= 0 && n <= 1_000_000_000) return n;
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'التكلفة رقمٌ لا يقلّ عن صفر بالليرة' });
          return z.NEVER;
        }),
      expires_at: z
        .union([z.date(), z.string()])
        .optional()
        .transform((v, ctx) => {
          if (v instanceof Date) return v.toISOString();
          if (!v || !v.trim()) return null;
          const d = new Date(v.trim());
          if (!Number.isNaN(d.getTime())) return d.toISOString();
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'تاريخ غير مفهوم — اكتبه 2027-06-30' });
          return z.NEVER;
        }),
    })
    .superRefine((r, ctx) => {
      if (r.qty === 0) return;
      if (r.unit_cost === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unit_cost'],
          message: 'التكلفة إلزامية مع الكمية — منها يُحسب الربح من أول بيع',
        });
      }
      if (held.has(`${r.branch}:${r.code.id}`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['code'],
          message: 'لهذا الصنف رصيدٌ أو حركات بهذا الفرع — صحّحه بالجرد لا برصيد افتتاحي',
        });
      }
    })
    .transform(
      (r): OpeningStockRow => ({
        skip: r.qty === 0,
        branch_id: r.branch,
        variant_id: r.code.id,
        unit_id: r.code.unit_id,
        qty: r.qty,
        unit_cost: r.unit_cost ?? 0,
        expires_at: r.expires_at,
      }),
    );
}

/** A receipt holds at most 200 lines — a big branch gets several. */
const RECEIPT_LINES = 200;

async function commitOpening(ctx: TransferContext, rows: OpeningStockRow[]) {
  const live = rows.filter((r) => !r.skip);
  const supplierId = live.length > 0 ? await openingSupplierId() : 0;
  const byBranch = new Map<number, OpeningStockRow[]>();
  for (const r of live) byBranch.set(r.branch_id, [...(byBranch.get(r.branch_id) ?? []), r]);
  const actor = {
    userId: ctx.userId,
    ipAddress: null,
    deviceInfo: null,
    performedByRole: null,
    branchContext: null,
    stationId: ctx.stationId ?? null,
  };
  for (const [branchId, list] of byBranch) {
    for (let i = 0; i < list.length; i += RECEIPT_LINES) {
      await createReceipt(actor, {
        branch_id: branchId,
        supplier_id: supplierId,
        supplier_invoice_no: null,
        invoice_date: new Date().toISOString(),
        currency: 'SYP',
        exchange_rate: null,
        note: 'رصيد افتتاحي — استيراد',
        lines: list.slice(i, i + RECEIPT_LINES).map((r) => ({
          variant_id: r.variant_id,
          unit_id: r.unit_id,
          qty: r.qty,
          unit_cost: r.unit_cost,
          expires_at: r.expires_at,
        })),
      });
    }
  }
  return { inserted: live.length, updated: 0, skipped: rows.length - live.length };
}

export const openingStockTransferResource = defineTransferResource({
  name: 'opening_stock',
  label: { ar: 'الرصيد الافتتاحي', en: 'Opening stock' },
  columns: [
    { key: 'branch', label: { ar: 'الفرع', en: 'Branch' }, type: 'string', required: true, example: 'ML',
      hint: { ar: 'إلزامي · رمز الفرع أو اسمه', en: 'Required · branch code or name' } },
    { key: 'code', label: { ar: 'SKU أو الباركود', en: 'SKU or barcode' }, type: 'string', required: true,
      example: 'NB-80', hint: { ar: 'إلزامي', en: 'Required' } },
    { key: 'name', label: { ar: 'الصنف', en: 'Item' }, type: 'string', importable: false,
      hint: { ar: 'للقراءة — من الكتالوج', en: 'For reference — from the catalogue' } },
    { key: 'unit', label: { ar: 'وحدة الأساس', en: 'Base unit' }, type: 'string', importable: false,
      hint: { ar: 'الكمية تُكتب بها', en: 'Quantities are in this unit' } },
    { key: 'on_hand', label: { ar: 'الرصيد الآن', en: 'On hand now' }, type: 'number', importable: false,
      hint: { ar: 'للقراءة — ما له رصيد لا يأخذ افتتاحياً', en: 'For reference — items with stock are refused' } },
    { key: 'qty', label: { ar: 'الكمية', en: 'Quantity' }, type: 'number', example: '24',
      hint: { ar: 'بوحدة الأساس · السطر الفارغ يُتخطّى', en: 'In the base unit · empty rows are skipped' } },
    { key: 'unit_cost', label: { ar: 'تكلفة الوحدة (ل.س)', en: 'Unit cost (SYP)' }, type: 'number', example: '1500',
      hint: { ar: 'إلزامية مع الكمية', en: 'Required with a quantity' } },
    { key: 'expires_at', label: { ar: 'تاريخ الانتهاء', en: 'Expiry date' }, type: 'date', example: '2027-06-30',
      hint: { ar: 'اختياري', en: 'Optional' } },
  ],
  filtersSchema,
  filters: [
    { key: 'branch', label: { ar: 'الفرع', en: 'Branch' }, type: 'select',
      placeholder: { ar: 'اختر الفرع — أو قائمة الأصناف وحدها', en: 'Pick a branch — or the item list only' } },
  ],
  async authorize(ctx: TransferContext, action) {
    await requirePermission(ctx.userId, action === 'import' ? 'inventory.receive' : 'inventory.view');
  },
  // The live branches by name (the value is the code the export reads), and a
  // first «no branch» choice: the item list alone, for a branch the counter
  // fills in by hand.
  async filterOptions() {
    const branches = await liveBranches();
    return {
      branch: [
        { value: '', label: { ar: 'بلا فرع — قائمة الأصناف وحدها', en: 'No branch — the item list only' } },
        ...branches.map((b) => ({
          value: b.code,
          label: { ar: `${b.name} (${b.code})`, en: `${b.name_en ?? b.name} (${b.code})` },
        })),
      ],
    };
  },
  countRows() {
    return countRows();
  },
  readRows(_ctx: TransferContext, filters: TransferFilters) {
    return readRows(filters['branch'] as string | undefined);
  },
  import: {
    rowSchema: z.object({}).passthrough(),
    prepareRowSchema,
    // The same item twice for one branch is a counting mistake, caught in the file.
    uniqueBy: ['branch', 'code'],
    onDuplicate: 'error',
    async commit(ctx: TransferContext, rows: unknown[]) {
      return commitOpening(ctx, rows as OpeningStockRow[]);
    },
  },
});
