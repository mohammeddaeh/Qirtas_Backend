import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { catalogBrandsTable } from '../../catalog/schemas/brands.schema.js';
import { catalogCategoriesTable } from '../../catalog/schemas/categories.schema.js';
import { catalogProductsTable, catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import {
  promotionBranchCapsTable,
  promotionBranchesTable,
  promotionTiersTable,
  promotionsTable,
  type NewPromotionRow,
  type PromotionRow,
} from '../schemas/promotions.schema.js';

export type PromotionLifecycle = 'live' | 'scheduled' | 'ended' | 'inactive' | 'archived';

export interface PromotionListFilters {
  search?: string;
  branchId?: number;
  kind?: PromotionRow['kind'];
  archived?: boolean;
  status?: PromotionLifecycle;
}

/**
 * الحالة تُصفّى **بالاستعلام** لا بعد التصفيح.
 *
 * تصفيتها بعده تُنتج صفحةً نصفها مفقود تحت `total` كبير — وهو بالضبط العطل
 * الذي ظهر بتصفّح المتجر (§25): صفحةٌ ناقصة تُقرأ عطلاً لا «لا يوجد عرضٌ بهذه
 * الحالة». وهذه نسخةٌ من قاعدة `statusOf` بـSQL، فأي تغيير هناك يُنقل هنا —
 * ويُمسك بالاختبار الحيّ الذي يقارن العدد بالصفوف.
 */
function statusClause(status: PromotionLifecycle) {
  const now = sql`now()`;
  switch (status) {
    case 'archived':
      return sql`${promotionsTable.archived_at} IS NOT NULL`;
    case 'inactive':
      return sql`${promotionsTable.archived_at} IS NULL AND ${promotionsTable.is_active} = false`;
    case 'scheduled':
      return sql`${promotionsTable.archived_at} IS NULL AND ${promotionsTable.is_active} = true
        AND ${promotionsTable.starts_at} IS NOT NULL AND ${promotionsTable.starts_at} > ${now}`;
    case 'ended':
      return sql`${promotionsTable.archived_at} IS NULL AND ${promotionsTable.is_active} = true
        AND ${promotionsTable.ends_at} IS NOT NULL AND ${promotionsTable.ends_at} <= ${now}
        AND (${promotionsTable.starts_at} IS NULL OR ${promotionsTable.starts_at} <= ${now})`;
    case 'live':
      return sql`${promotionsTable.archived_at} IS NULL AND ${promotionsTable.is_active} = true
        AND (${promotionsTable.starts_at} IS NULL OR ${promotionsTable.starts_at} <= ${now})
        AND (${promotionsTable.ends_at} IS NULL OR ${promotionsTable.ends_at} > ${now})`;
  }
}

/**
 * الصفوف كما هي بالقاعدة. أي حكمٍ على العرض — هل يسري، بكم، أيّهما أفضل —
 * يقع بـ`promotion-rules.ts` وحده: استعلامٌ يقرّر بنفسه يجعل القاعدة موجودة
 * بمكانين، وأحدهما لا يُختبر.
 */

export async function findPromotions(
  filters: PromotionListFilters,
  limit: number,
  offset: number,
): Promise<{ rows: PromotionRow[]; total: number }> {
  // طلب حالة «مؤرشف» هو نفسه طلب الأرشيف — وإلا تناقض الشرطان وعادت صفحة فارغة أبداً.
  const wantArchived = filters.archived === true || filters.status === 'archived';
  const clauses = [
    wantArchived
      ? sql`${promotionsTable.archived_at} IS NOT NULL`
      : isNull(promotionsTable.archived_at),
  ];
  if (filters.search) {
    clauses.push(
      or(
        ilike(promotionsTable.name_ar, `%${filters.search}%`),
        ilike(promotionsTable.name_en, `%${filters.search}%`),
      )!,
    );
  }
  if (filters.kind) clauses.push(eq(promotionsTable.kind, filters.kind));
  if (filters.status) clauses.push(statusClause(filters.status));
  if (filters.branchId !== undefined) {
    // فرعٌ يرى ما ينطبق عليه: المركزي (كل الفروع) وما خُصّص له.
    clauses.push(
      or(
        eq(promotionsTable.scope, 'all_branches'),
        sql`EXISTS (SELECT 1 FROM ${promotionBranchesTable} pb
              WHERE pb.promotion_id = ${promotionsTable.id} AND pb.branch_id = ${filters.branchId})`,
      )!,
    );
  }
  const where = and(...clauses);

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(promotionsTable)
      .where(where)
      // الأحدث أولاً: العرض المُنشأ الآن هو الذي يُراجَع الآن.
      .orderBy(desc(promotionsTable.created_at), desc(promotionsTable.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<string>`count(*)` }).from(promotionsTable).where(where),
  ]);
  return { rows, total: Number(counted[0]?.count ?? 0) };
}

export async function findPromotionById(id: number): Promise<PromotionRow | undefined> {
  const [row] = await db.select().from(promotionsTable).where(eq(promotionsTable.id, id)).limit(1);
  return row;
}

/** العروض المرشَّحة للسريان — الفعّال غير المؤرشف وحده. الفلترة الباقية بالقواعد الصافية. */
export async function findCandidates(): Promise<PromotionRow[]> {
  return db
    .select()
    .from(promotionsTable)
    .where(and(eq(promotionsTable.is_active, true), isNull(promotionsTable.archived_at)))
    .orderBy(asc(promotionsTable.id));
}

export async function findBranchLinks(
  promotionIds: number[],
): Promise<{ promotion_id: number; branch_id: number }[]> {
  if (promotionIds.length === 0) return [];
  return db
    .select({
      promotion_id: promotionBranchesTable.promotion_id,
      branch_id: promotionBranchesTable.branch_id,
    })
    .from(promotionBranchesTable)
    .where(inArray(promotionBranchesTable.promotion_id, promotionIds));
}

export async function findTiers(promotionIds: number[]) {
  if (promotionIds.length === 0) return [];
  return db
    .select()
    .from(promotionTiersTable)
    .where(inArray(promotionTiersTable.promotion_id, promotionIds))
    .orderBy(asc(promotionTiersTable.min_qty));
}

export async function insertPromotion(values: NewPromotionRow): Promise<PromotionRow> {
  const [row] = await db.insert(promotionsTable).values(values).returning();
  return row!;
}

export async function updatePromotion(
  id: number,
  values: Partial<NewPromotionRow>,
): Promise<PromotionRow | undefined> {
  const [row] = await db
    .update(promotionsTable)
    .set({ ...values, updated_at: new Date() })
    .where(eq(promotionsTable.id, id))
    .returning();
  return row;
}

export async function deletePromotion(id: number): Promise<void> {
  await db.delete(promotionsTable).where(eq(promotionsTable.id, id));
}

export async function replaceBranchLinks(promotionId: number, branchIds: number[]): Promise<void> {
  await db.delete(promotionBranchesTable).where(eq(promotionBranchesTable.promotion_id, promotionId));
  if (branchIds.length > 0) {
    await db
      .insert(promotionBranchesTable)
      .values(branchIds.map((branch_id) => ({ promotion_id: promotionId, branch_id })));
  }
}

export async function replaceTiers(
  promotionId: number,
  tiers: { min_qty: number; percent_value: string | null; amount_syp: string | null }[],
): Promise<void> {
  await db.delete(promotionTiersTable).where(eq(promotionTiersTable.promotion_id, promotionId));
  if (tiers.length > 0) {
    await db.insert(promotionTiersTable).values(tiers.map((t) => ({ ...t, promotion_id: promotionId })));
  }
}

// ── السقوف ──────────────────────────────────────────────────────────────────

export async function findCaps(): Promise<{ branch_id: number; max_discount_percent: string }[]> {
  return db
    .select({
      branch_id: promotionBranchCapsTable.branch_id,
      max_discount_percent: promotionBranchCapsTable.max_discount_percent,
    })
    .from(promotionBranchCapsTable);
}

export async function upsertCap(
  branchId: number,
  percent: string,
  userId: number | null,
): Promise<void> {
  await db
    .insert(promotionBranchCapsTable)
    .values({ branch_id: branchId, max_discount_percent: percent, updated_by: userId })
    .onConflictDoUpdate({
      target: promotionBranchCapsTable.branch_id,
      set: { max_discount_percent: percent, updated_by: userId, updated_at: new Date() },
    });
}

export async function findLiveBranches(): Promise<{ id: number; name_ar: string }[]> {
  return db
    .select({ id: branchesTable.id, name_ar: branchesTable.name })
    .from(branchesTable)
    .where(isNull(branchesTable.archived_at))
    .orderBy(asc(branchesTable.name));
}

// ── ما يحتاجه الهدف ليُعرض وليُقاس ──────────────────────────────────────────

/** كل التصنيفات بآبائها — الشجرة ١٤٦ صفاً بثلاثة مستويات، فقراءتها كاملةً أرخص من استعلام متكرر. */
export async function findCategoryParents(): Promise<{ id: number; parent_id: number | null }[]> {
  return db
    .select({ id: catalogCategoriesTable.id, parent_id: catalogCategoriesTable.parent_id })
    .from(catalogCategoriesTable);
}

/** المتغيّرات التي يمسّها هدفٌ ما — به يُقاس حارس الخسارة قبل الحفظ. */
export async function findVariantsForTarget(target: {
  variant_id: number | null;
  product_id: number | null;
  category_id: number | null;
  brand_id: number | null;
}): Promise<{ variant_id: number; product_id: number; name_ar: string }[]> {
  const base = db
    .select({
      variant_id: catalogVariantsTable.id,
      product_id: catalogProductsTable.id,
      name_ar: catalogProductsTable.name_ar,
    })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogVariantsTable.product_id, catalogProductsTable.id));

  if (target.variant_id !== null) {
    return base.where(eq(catalogVariantsTable.id, target.variant_id));
  }
  if (target.product_id !== null) {
    return base.where(eq(catalogProductsTable.id, target.product_id));
  }
  if (target.brand_id !== null) {
    return base.where(eq(catalogProductsTable.brand_id, target.brand_id)).limit(200);
  }
  if (target.category_id !== null) {
    // التصنيف وأبناؤه (ثلاثة مستويات بالأكثر) — عرضُ الأب يشمل ما تحته.
    return base
      .where(
        sql`${catalogProductsTable.category_id} IN (
          WITH RECURSIVE tree AS (
            SELECT id FROM catalog_categories WHERE id = ${target.category_id}
            UNION ALL
            SELECT c.id FROM catalog_categories c JOIN tree t ON c.parent_id = t.id
          ) SELECT id FROM tree)`,
      )
      .limit(200);
  }
  return [];
}

/** تصنيف كل متغيّر وماركته — ما تحتاجه القواعد لتقرّر الانطباق. */
export async function findVariantContext(
  variantIds: number[],
): Promise<
  { variant_id: number; product_id: number; category_id: number | null; brand_id: number | null }[]
> {
  if (variantIds.length === 0) return [];
  return db
    .select({
      variant_id: catalogVariantsTable.id,
      product_id: catalogProductsTable.id,
      category_id: catalogProductsTable.category_id,
      brand_id: catalogProductsTable.brand_id,
    })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogVariantsTable.product_id, catalogProductsTable.id))
    .where(inArray(catalogVariantsTable.id, variantIds));
}

/** اسم الهدف كما يُعرض بالقائمة — «عرض على ٣٤» سطرٌ لا يُقرأ. */
export async function findTargetLabel(row: PromotionRow): Promise<string | null> {
  if (row.variant_id !== null) {
    const [r] = await db
      .select({ name: catalogProductsTable.name_ar, sku: catalogVariantsTable.sku })
      .from(catalogVariantsTable)
      .innerJoin(catalogProductsTable, eq(catalogVariantsTable.product_id, catalogProductsTable.id))
      .where(eq(catalogVariantsTable.id, row.variant_id))
      .limit(1);
    return r ? `${r.name} — ${r.sku}` : null;
  }
  if (row.product_id !== null) {
    const [r] = await db
      .select({ name: catalogProductsTable.name_ar })
      .from(catalogProductsTable)
      .where(eq(catalogProductsTable.id, row.product_id))
      .limit(1);
    return r?.name ?? null;
  }
  if (row.category_id !== null) {
    const [r] = await db
      .select({ name: catalogCategoriesTable.name_ar })
      .from(catalogCategoriesTable)
      .where(eq(catalogCategoriesTable.id, row.category_id))
      .limit(1);
    return r?.name ?? null;
  }
  if (row.brand_id !== null) {
    const [r] = await db
      .select({ name: catalogBrandsTable.name })
      .from(catalogBrandsTable)
      .where(eq(catalogBrandsTable.id, row.brand_id))
      .limit(1);
    return r?.name ?? null;
  }
  return null;
}
