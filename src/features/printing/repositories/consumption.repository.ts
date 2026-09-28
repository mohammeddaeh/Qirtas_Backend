import { and, asc, eq, ilike, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import { catalogUnitsTable } from '../../catalog/schemas/units.schema.js';
import { db } from '../../../core/db/client.js';
import {
  catalogProductsTable,
  catalogVariantsTable,
} from '../../catalog/schemas/products.schema.js';
import {
  printConsumableMetersTable,
  printConsumableReconciliationsTable,
  printConsumptionRulesTable,
  printJobConsumptionTable,
  type ConsumptionBasis,
  type PrintConsumableMeterRow,
} from '../schemas/print-consumption.schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

export interface RuleWithMaterial {
  id: number;
  option_id: number;
  variant_id: number;
  basis: ConsumptionBasis;
  qty: string | null;
  yield_pages: number | null;
  name_ar: string;
  sku: string;
}

/** القواعد مع اسم المادة ورمزها — المادة تُقرأ باسمها لا بمعرّفها. */
export async function findRules(exec: Exec = db): Promise<RuleWithMaterial[]> {
  return exec
    .select({
      id: printConsumptionRulesTable.id,
      option_id: printConsumptionRulesTable.option_id,
      variant_id: printConsumptionRulesTable.variant_id,
      basis: printConsumptionRulesTable.basis,
      qty: printConsumptionRulesTable.qty,
      yield_pages: printConsumptionRulesTable.yield_pages,
      name_ar: catalogProductsTable.name_ar,
      sku: catalogVariantsTable.sku,
    })
    .from(printConsumptionRulesTable)
    .innerJoin(
      catalogVariantsTable,
      eq(catalogVariantsTable.id, printConsumptionRulesTable.variant_id),
    )
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .orderBy(asc(printConsumptionRulesTable.option_id), asc(printConsumptionRulesTable.id));
}

/** الوصفة **تُستبدل كاملةً** بمعاملة واحدة — نصف وصفة يُخصم نصف المواد. */
export async function replaceRules(
  rows: {
    option_id: number;
    variant_id: number;
    basis: ConsumptionBasis;
    qty: string | null;
    yield_pages: number | null;
  }[],
  userId: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(printConsumptionRulesTable);
    if (rows.length > 0) {
      await tx
        .insert(printConsumptionRulesTable)
        .values(rows.map((r) => ({ ...r, updated_by: userId })));
    }
  });
}

export async function findExistingVariantIds(ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: catalogVariantsTable.id })
    .from(catalogVariantsTable)
    .where(inArray(catalogVariantsTable.id, ids));
  return rows.map((r) => r.id);
}

/** عدّاد المادة بالفرع **مقفلاً** — يُنشأ بأول استعمال. */
export async function lockMeter(
  tx: Tx,
  branchId: number,
  variantId: number,
): Promise<PrintConsumableMeterRow> {
  await tx
    .insert(printConsumableMetersTable)
    .values({ branch_id: branchId, variant_id: variantId })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(printConsumableMetersTable)
    .where(
      and(
        eq(printConsumableMetersTable.branch_id, branchId),
        eq(printConsumableMetersTable.variant_id, variantId),
      ),
    )
    .for('update')
    .limit(1);
  return row!;
}

export async function updateMeter(
  tx: Tx,
  branchId: number,
  variantId: number,
  patch: Partial<typeof printConsumableMetersTable.$inferInsert>,
): Promise<void> {
  await tx
    .update(printConsumableMetersTable)
    .set({ ...patch, updated_at: new Date() })
    .where(
      and(
        eq(printConsumableMetersTable.branch_id, branchId),
        eq(printConsumableMetersTable.variant_id, variantId),
      ),
    );
}

export async function insertJobConsumption(
  tx: Tx,
  rows: (typeof printJobConsumptionTable.$inferInsert)[],
): Promise<void> {
  if (rows.length > 0) await tx.insert(printJobConsumptionTable).values(rows);
}

export async function findJobConsumption(jobId: number) {
  return db
    .select({
      variant_id: printJobConsumptionTable.variant_id,
      qty: printJobConsumptionTable.qty,
      unit_cost_syp: printJobConsumptionTable.unit_cost_syp,
      cost_syp: printJobConsumptionTable.cost_syp,
      name_ar: catalogProductsTable.name_ar,
      sku: catalogVariantsTable.sku,
    })
    .from(printJobConsumptionTable)
    .innerJoin(
      catalogVariantsTable,
      eq(catalogVariantsTable.id, printJobConsumptionTable.variant_id),
    )
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(eq(printJobConsumptionTable.job_id, jobId))
    .orderBy(asc(catalogProductsTable.name_ar));
}

/** عدّادات المواد **بالمردود** بفرعٍ — ما يُعرض عليه «ركّبت علبة جديدة». */
export async function findYieldMeters(branchId: number) {
  const yieldVariants = db
    .selectDistinct({ variant_id: printConsumptionRulesTable.variant_id })
    .from(printConsumptionRulesTable)
    .where(isNotNull(printConsumptionRulesTable.yield_pages));
  const ids = (await yieldVariants).map((r) => r.variant_id);
  if (ids.length === 0) return [];
  const [materials, meters] = await Promise.all([
    db
      .select({
        variant_id: catalogVariantsTable.id,
        name_ar: catalogProductsTable.name_ar,
        sku: catalogVariantsTable.sku,
      })
      .from(catalogVariantsTable)
      .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
      .where(inArray(catalogVariantsTable.id, ids)),
    db
      .select()
      .from(printConsumableMetersTable)
      .where(
        and(
          eq(printConsumableMetersTable.branch_id, branchId),
          inArray(printConsumableMetersTable.variant_id, ids),
        ),
      ),
  ]);
  const byVariant = new Map(meters.map((m) => [m.variant_id, m]));
  return materials.map((m) => ({ ...m, meter: byVariant.get(m.variant_id) ?? null }));
}

export async function isYieldMaterial(variantId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: printConsumptionRulesTable.id })
    .from(printConsumptionRulesTable)
    .where(
      and(
        eq(printConsumptionRulesTable.variant_id, variantId),
        isNotNull(printConsumptionRulesTable.yield_pages),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function insertReconciliation(
  tx: Tx,
  row: typeof printConsumableReconciliationsTable.$inferInsert,
) {
  const [created] = await tx.insert(printConsumableReconciliationsTable).values(row).returning();
  return created!;
}

/**
 * أصنافٌ تصلح مادةً للوصفة — بحثٌ بالاسم (مطويّاً) أو الرمز، **بوحدة الأساس**:
 * كمية الوصفة تُكتب بها (الورقة لا الرزمة)، وكتابتها بغيرها تخصم أضعافاً.
 */
export async function searchMaterials(search: string, limit: number) {
  const term = `%${search.trim()}%`;
  const folded = `%${normalizeArabic(search.trim())}%`;
  return db
    .select({
      variant_id: catalogVariantsTable.id,
      name_ar: catalogProductsTable.name_ar,
      sku: catalogVariantsTable.sku,
      unit_name_ar: catalogUnitsTable.name_ar,
    })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .innerJoin(catalogUnitsTable, eq(catalogUnitsTable.id, catalogVariantsTable.base_unit_id))
    .where(
      and(
        isNull(catalogProductsTable.archived_at),
        or(ilike(catalogProductsTable.search_text, folded), ilike(catalogVariantsTable.sku, term)),
      ),
    )
    .orderBy(asc(catalogProductsTable.name_ar), asc(catalogVariantsTable.id))
    .limit(limit);
}
