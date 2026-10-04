import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import {
  printBranchFinishingRatesTable,
  printBranchOptionsTable,
  printBranchPageRatesTable,
  printFinishingRatesTable,
  printOptionsTable,
  printPageRatesTable,
  printQuantityTiersTable,
  printSettingsTable,
  type NewPrintOptionRow,
  type PrintOptionRow,
  type PrintSettingsRow,
} from '../schemas/printing.schema.js';

// ── الخيارات ────────────────────────────────────────────────────────────────

export function findOptions(): Promise<PrintOptionRow[]> {
  return db
    .select()
    .from(printOptionsTable)
    .orderBy(
      asc(printOptionsTable.kind),
      asc(printOptionsTable.sort_order),
      asc(printOptionsTable.id),
    );
}

export async function findOption(id: number): Promise<PrintOptionRow | undefined> {
  const rows = await db
    .select()
    .from(printOptionsTable)
    .where(eq(printOptionsTable.id, id))
    .limit(1);
  return rows[0];
}

export async function findOptionByCode(
  kind: PrintOptionRow['kind'],
  code: string,
): Promise<PrintOptionRow | undefined> {
  const rows = await db
    .select()
    .from(printOptionsTable)
    .where(and(eq(printOptionsTable.kind, kind), eq(printOptionsTable.code, code)))
    .limit(1);
  return rows[0];
}

export async function insertOption(data: NewPrintOptionRow): Promise<PrintOptionRow> {
  const rows = await db.insert(printOptionsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function updateOption(
  id: number,
  data: Partial<Pick<NewPrintOptionRow, 'name_ar' | 'name_en' | 'sort_order' | 'is_active'>>,
): Promise<PrintOptionRow | undefined> {
  const rows = await db
    .update(printOptionsTable)
    .set(data)
    .where(eq(printOptionsTable.id, id))
    .returning();
  return rows[0];
}

// ── الأسعار المركزية ────────────────────────────────────────────────────────

export interface PageRateCell {
  paper_size_id: number;
  color_mode_id: number;
  sides_id: number;
  amount_syp: string;
}

export function findPageRates(): Promise<PageRateCell[]> {
  return db
    .select({
      paper_size_id: printPageRatesTable.paper_size_id,
      color_mode_id: printPageRatesTable.color_mode_id,
      sides_id: printPageRatesTable.sides_id,
      amount_syp: printPageRatesTable.amount_syp,
    })
    .from(printPageRatesTable);
}

export function findFinishingRates(): Promise<{ option_id: number; amount_syp: string }[]> {
  return db
    .select({
      option_id: printFinishingRatesTable.option_id,
      amount_syp: printFinishingRatesTable.amount_syp,
    })
    .from(printFinishingRatesTable);
}

/**
 * الخلايا المرسلة وحدها تُكتب: `amount = null` يحذف الخلية، والخلية الغائبة
 * عن الطلب تبقى كما هي — استبدالُ المصفوفة كلها كان سيمحو ما لم يعرضه عميلٌ
 * قديم لم يعرف بمقاسٍ أُضيف بعده.
 */
export async function writePageRates(
  cells: {
    paper_size_id: number;
    color_mode_id: number;
    sides_id: number;
    amount_syp: string | null;
  }[],
  userId: number | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const c of cells) {
      const where = and(
        eq(printPageRatesTable.paper_size_id, c.paper_size_id),
        eq(printPageRatesTable.color_mode_id, c.color_mode_id),
        eq(printPageRatesTable.sides_id, c.sides_id),
      );
      if (c.amount_syp === null) {
        await tx.delete(printPageRatesTable).where(where);
        continue;
      }
      await tx
        .insert(printPageRatesTable)
        .values({ ...c, amount_syp: c.amount_syp, updated_by: userId })
        .onConflictDoUpdate({
          target: [
            printPageRatesTable.paper_size_id,
            printPageRatesTable.color_mode_id,
            printPageRatesTable.sides_id,
          ],
          set: { amount_syp: c.amount_syp, updated_by: userId, updated_at: new Date() },
        });
    }
  });
}

export async function writeFinishingRates(
  rows: { option_id: number; amount_syp: string | null }[],
  userId: number | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const r of rows) {
      if (r.amount_syp === null) {
        await tx
          .delete(printFinishingRatesTable)
          .where(eq(printFinishingRatesTable.option_id, r.option_id));
        continue;
      }
      await tx
        .insert(printFinishingRatesTable)
        .values({ option_id: r.option_id, amount_syp: r.amount_syp, updated_by: userId })
        .onConflictDoUpdate({
          target: printFinishingRatesTable.option_id,
          set: { amount_syp: r.amount_syp, updated_by: userId, updated_at: new Date() },
        });
    }
  });
}

// ── الشرائح والإعدادات ──────────────────────────────────────────────────────

export function findTiers(): Promise<{ min_pages: number; discount_percent: string }[]> {
  return db
    .select({
      min_pages: printQuantityTiersTable.min_pages,
      discount_percent: printQuantityTiersTable.discount_percent,
    })
    .from(printQuantityTiersTable)
    .orderBy(asc(printQuantityTiersTable.min_pages));
}

/** الشرائح قائمة واحدة تُستبدل كاملة — العتبات تُقرأ معاً لا صفّاً صفّاً. */
export async function replaceTiers(
  tiers: { min_pages: number; discount_percent: string }[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(printQuantityTiersTable);
    if (tiers.length > 0) await tx.insert(printQuantityTiersTable).values(tiers);
  });
}

const SETTINGS_ID = 1;

/**
 * الإعدادات صفٌّ واحد يُنشأ بقيمه الافتراضية عند أول قراءة — قاعدةٌ لم تمرّ
 * بالبذرة (أو هاجرت قبلها) لا تُرجع «لا إعدادات» فيُسعَّر كل شيء بلا نطاق.
 */
export async function getSettings(): Promise<PrintSettingsRow> {
  const rows = await db
    .select()
    .from(printSettingsTable)
    .where(eq(printSettingsTable.id, SETTINGS_ID))
    .limit(1);
  if (rows[0]) return rows[0];
  const created = await db
    .insert(printSettingsTable)
    .values({ id: SETTINGS_ID })
    .onConflictDoNothing()
    .returning();
  if (created[0]) return created[0];
  const again = await db
    .select()
    .from(printSettingsTable)
    .where(eq(printSettingsTable.id, SETTINGS_ID))
    .limit(1);
  return again[0]!;
}

export async function updateSettings(
  data: Partial<
    Pick<
      PrintSettingsRow,
      'branch_band_percent' | 'file_retention_days' | 'max_file_mb' | 'max_pages'
    >
  >,
  userId: number | null,
): Promise<void> {
  await getSettings();
  await db
    .update(printSettingsTable)
    .set({ ...data, updated_by: userId, updated_at: new Date() })
    .where(eq(printSettingsTable.id, SETTINGS_ID));
}

// ── الفرع ───────────────────────────────────────────────────────────────────

export async function findLiveBranch(
  id: number,
): Promise<{ id: number; name: string } | undefined> {
  const rows = await db
    .select({ id: branchesTable.id, name: branchesTable.name })
    .from(branchesTable)
    .where(and(eq(branchesTable.id, id), isNull(branchesTable.archived_at)))
    .limit(1);
  return rows[0];
}

export function findLiveBranches(): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: branchesTable.id, name: branchesTable.name })
    .from(branchesTable)
    .where(isNull(branchesTable.archived_at))
    // الافتراضي أولاً (2026-09-30): الشاشات تختار أول فرع تلقائياً، والترتيب
    // بالاسم وحده كان يفتح الصندوق والطوابير على فرع اختبارٍ لاتيني الاسم.
    .orderBy(desc(branchesTable.is_default), asc(branchesTable.name));
}

export async function findDisabledOptionIds(branchId: number): Promise<number[]> {
  const rows = await db
    .select({ option_id: printBranchOptionsTable.option_id })
    .from(printBranchOptionsTable)
    .where(
      and(
        eq(printBranchOptionsTable.branch_id, branchId),
        eq(printBranchOptionsTable.is_enabled, false),
      ),
    );
  return rows.map((r) => r.option_id);
}

export async function writeBranchOptions(
  branchId: number,
  rows: { option_id: number; is_enabled: boolean }[],
  userId: number | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const r of rows) {
      await tx
        .insert(printBranchOptionsTable)
        .values({
          branch_id: branchId,
          option_id: r.option_id,
          is_enabled: r.is_enabled,
          updated_by: userId,
        })
        .onConflictDoUpdate({
          target: [printBranchOptionsTable.branch_id, printBranchOptionsTable.option_id],
          set: { is_enabled: r.is_enabled, updated_by: userId, updated_at: new Date() },
        });
    }
  });
}

export function findBranchPageRates(branchId: number): Promise<PageRateCell[]> {
  return db
    .select({
      paper_size_id: printBranchPageRatesTable.paper_size_id,
      color_mode_id: printBranchPageRatesTable.color_mode_id,
      sides_id: printBranchPageRatesTable.sides_id,
      amount_syp: printBranchPageRatesTable.amount_syp,
    })
    .from(printBranchPageRatesTable)
    .where(eq(printBranchPageRatesTable.branch_id, branchId));
}

export function findBranchFinishingRates(
  branchId: number,
): Promise<{ option_id: number; amount_syp: string }[]> {
  return db
    .select({
      option_id: printBranchFinishingRatesTable.option_id,
      amount_syp: printBranchFinishingRatesTable.amount_syp,
    })
    .from(printBranchFinishingRatesTable)
    .where(eq(printBranchFinishingRatesTable.branch_id, branchId));
}

export async function writeBranchRates(
  branchId: number,
  pageCells: {
    paper_size_id: number;
    color_mode_id: number;
    sides_id: number;
    amount_syp: string | null;
  }[],
  finishing: { option_id: number; amount_syp: string | null }[],
  userId: number | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const c of pageCells) {
      const where = and(
        eq(printBranchPageRatesTable.branch_id, branchId),
        eq(printBranchPageRatesTable.paper_size_id, c.paper_size_id),
        eq(printBranchPageRatesTable.color_mode_id, c.color_mode_id),
        eq(printBranchPageRatesTable.sides_id, c.sides_id),
      );
      if (c.amount_syp === null) {
        await tx.delete(printBranchPageRatesTable).where(where);
        continue;
      }
      await tx
        .insert(printBranchPageRatesTable)
        .values({ branch_id: branchId, ...c, amount_syp: c.amount_syp, updated_by: userId })
        .onConflictDoUpdate({
          target: [
            printBranchPageRatesTable.branch_id,
            printBranchPageRatesTable.paper_size_id,
            printBranchPageRatesTable.color_mode_id,
            printBranchPageRatesTable.sides_id,
          ],
          set: { amount_syp: c.amount_syp, updated_by: userId, updated_at: new Date() },
        });
    }
    for (const r of finishing) {
      const where = and(
        eq(printBranchFinishingRatesTable.branch_id, branchId),
        eq(printBranchFinishingRatesTable.option_id, r.option_id),
      );
      if (r.amount_syp === null) {
        await tx.delete(printBranchFinishingRatesTable).where(where);
        continue;
      }
      await tx
        .insert(printBranchFinishingRatesTable)
        .values({
          branch_id: branchId,
          option_id: r.option_id,
          amount_syp: r.amount_syp,
          updated_by: userId,
        })
        .onConflictDoUpdate({
          target: [
            printBranchFinishingRatesTable.branch_id,
            printBranchFinishingRatesTable.option_id,
          ],
          set: { amount_syp: r.amount_syp, updated_by: userId, updated_at: new Date() },
        });
    }
  });
}
