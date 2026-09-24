import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { userRoleAssignmentsTable } from '../../identity/schemas/user-role-assignments.schema.js';
import { catalogProductsTable, catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { stockBalancesTable } from '../../inventory/schemas/stock.schema.js';
import {
  customerCreditLimitsTable,
  customerLedgerTable,
  roleDiscountCapsTable,
  saleLinesTable,
  salePaymentsTable,
  saleSequencesTable,
  salesTable,
  type NewSaleRow,
  type SaleLineRow,
  type SaleRow,
} from '../schemas/sales.schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

// ── السلّة ──────────────────────────────────────────────────────────────────

export async function insertSale(values: NewSaleRow, exec: Exec = db): Promise<SaleRow> {
  const [row] = await exec.insert(salesTable).values(values).returning();
  return row!;
}

export async function findSaleById(id: number, exec: Exec = db): Promise<SaleRow | undefined> {
  const [row] = await exec.select().from(salesTable).where(eq(salesTable.id, id)).limit(1);
  return row;
}

/**
 * الصفّ **مقفلاً** — كل كتابة على سلّة تمرّ من هنا.
 *
 * بلا القفل يُسدَّد كاشيران السلّة نفسها من جهازين، فتخرج البضاعة مرتين
 * ويُصرَف رقمان لبيعةٍ واحدة.
 */
export async function lockSale(exec: Exec, id: number): Promise<SaleRow | undefined> {
  const rows = await exec.execute(
    sql`SELECT * FROM ${salesTable} WHERE ${salesTable.id} = ${id} FOR UPDATE`,
  );
  const list = (rows as unknown as { rows?: SaleRow[] }).rows ?? (rows as unknown as SaleRow[]);
  return list[0];
}

export async function updateSale(
  exec: Exec,
  id: number,
  values: Partial<NewSaleRow>,
): Promise<SaleRow | undefined> {
  const [row] = await exec.update(salesTable).set(values).where(eq(salesTable.id, id)).returning();
  return row;
}

/**
 * سلّات هذا الكاشير المفتوحة والمعلَّقة — **ما ينتظره على جهازه**.
 *
 * سلّات غيره لا تُعرض: سلّةٌ يفتحها زميل بجهاز آخر تُقرأ هنا «نسيتُها»
 * فتُلغى، والزبون واقفٌ عند الصندوق الآخر.
 */
export async function findOpenSales(branchId: number, cashierId: number): Promise<SaleRow[]> {
  return db
    .select()
    .from(salesTable)
    .where(
      and(
        eq(salesTable.branch_id, branchId),
        eq(salesTable.cashier_user_id, cashierId),
        inArray(salesTable.status, ['open', 'held']),
      ),
    )
    .orderBy(desc(salesTable.created_at));
}

export async function findSales(
  filters: { branchId?: number; cashierId?: number; status?: SaleRow['status'] },
  limit: number,
  offset: number,
): Promise<{ rows: SaleRow[]; total: number }> {
  const clauses = [];
  if (filters.branchId !== undefined) clauses.push(eq(salesTable.branch_id, filters.branchId));
  if (filters.cashierId !== undefined) clauses.push(eq(salesTable.cashier_user_id, filters.cashierId));
  if (filters.status !== undefined) clauses.push(eq(salesTable.status, filters.status));
  const where = clauses.length > 0 ? and(...clauses) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(salesTable)
      .where(where)
      .orderBy(desc(salesTable.created_at), desc(salesTable.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<string>`count(*)` }).from(salesTable).where(where),
  ]);
  return { rows, total: Number(counted[0]?.count ?? 0) };
}

// ── السطور ──────────────────────────────────────────────────────────────────

export async function findLines(saleId: number, exec: Exec = db): Promise<SaleLineRow[]> {
  return exec
    .select()
    .from(saleLinesTable)
    .where(eq(saleLinesTable.sale_id, saleId))
    .orderBy(saleLinesTable.id);
}

export async function findLineById(
  saleId: number,
  lineId: number,
): Promise<SaleLineRow | undefined> {
  const [row] = await db
    .select()
    .from(saleLinesTable)
    .where(and(eq(saleLinesTable.sale_id, saleId), eq(saleLinesTable.id, lineId)))
    .limit(1);
  return row;
}

export async function findLineFor(
  saleId: number,
  variantId: number,
  unitId: number | null,
): Promise<SaleLineRow | undefined> {
  const [row] = await db
    .select()
    .from(saleLinesTable)
    .where(
      and(
        eq(saleLinesTable.sale_id, saleId),
        eq(saleLinesTable.variant_id, variantId),
        unitId === null ? isNull(saleLinesTable.unit_id) : eq(saleLinesTable.unit_id, unitId),
      ),
    )
    .limit(1);
  return row;
}

export async function insertLine(
  values: typeof saleLinesTable.$inferInsert,
  exec: Exec = db,
): Promise<SaleLineRow> {
  const [row] = await exec.insert(saleLinesTable).values(values).returning();
  return row!;
}

export async function updateLine(
  exec: Exec,
  lineId: number,
  values: Partial<typeof saleLinesTable.$inferInsert>,
): Promise<void> {
  await exec.update(saleLinesTable).set(values).where(eq(saleLinesTable.id, lineId));
}

export async function deleteLine(saleId: number, lineId: number): Promise<void> {
  await db
    .delete(saleLinesTable)
    .where(and(eq(saleLinesTable.sale_id, saleId), eq(saleLinesTable.id, lineId)));
}

// ── الدفعات ─────────────────────────────────────────────────────────────────

export async function insertPayments(
  exec: Exec,
  rows: (typeof salePaymentsTable.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(salePaymentsTable).values(rows);
}

export async function findPayments(saleId: number) {
  return db.select().from(salePaymentsTable).where(eq(salePaymentsTable.sale_id, saleId));
}

// ── الترقيم ─────────────────────────────────────────────────────────────────

/**
 * التسلسل التالي لهذا (الفرع × السنة) — **بصفٍّ مقفَل داخل معاملة السداد**.
 *
 * `max(number)+1` يعطي كاشيرين متزامنين الرقم نفسه، فيفشل أحدهما بعد أن سلّم
 * البضاعة. والقفل هنا يجعل الفجوة مستحيلة: الرقم يُصرَف بالمعاملة نفسها،
 * وفشلها يُرجعه.
 */
export async function nextSequence(exec: Exec, branchId: number, year: number): Promise<number> {
  const result = await exec.execute(
    sql`INSERT INTO ${saleSequencesTable} (branch_id, year, last_sequence)
        VALUES (${branchId}, ${year}, 1)
        ON CONFLICT (branch_id, year)
        DO UPDATE SET last_sequence = ${saleSequencesTable}.last_sequence + 1
        RETURNING last_sequence`,
  );
  const list =
    (result as unknown as { rows?: { last_sequence: number }[] }).rows ??
    (result as unknown as { last_sequence: number }[]);
  return Number(list[0]?.last_sequence ?? 1);
}

export async function findBranch(branchId: number): Promise<{ id: number; name: string } | undefined> {
  const [row] = await db
    .select({ id: branchesTable.id, name: branchesTable.name })
    .from(branchesTable)
    .where(eq(branchesTable.id, branchId))
    .limit(1);
  return row;
}

// ── الخصم وسقوفه ────────────────────────────────────────────────────────────

/**
 * أعلى سقف خصمٍ يملكه هذا المستخدم — **من كل أدواره**، لا من أحدها.
 *
 * موظفٌ يحمل دورين يأخذ الأعلى: قصرُه على دورٍ بعينه يجعل مدير فرعٍ يعمل
 * كاشيراً بالعيد عاجزاً عن خصمٍ يملكه بصفته الأخرى.
 */
export async function findDiscountCapFor(
  userId: number,
): Promise<{ cap: number; canApprove: boolean }> {
  const rows = await db
    .select({
      cap: roleDiscountCapsTable.max_discount_percent,
      canApprove: roleDiscountCapsTable.can_approve,
    })
    .from(userRoleAssignmentsTable)
    .innerJoin(roleDiscountCapsTable, eq(roleDiscountCapsTable.role_id, userRoleAssignmentsTable.role_id))
    .where(
      and(
        eq(userRoleAssignmentsTable.user_id, userId),
        isNull(userRoleAssignmentsTable.valid_to),
      ),
    );
  let cap = 0;
  let canApprove = false;
  for (const row of rows) {
    cap = Math.max(cap, Number(row.cap));
    canApprove = canApprove || row.canApprove;
  }
  return { cap, canApprove };
}

/** أعلى سقفٍ بالمنظمة كلّها — فوقه لا يوجد من يوافق، فالرفض هو الجواب الصادق. */
export async function findMaxApprovableCap(): Promise<number> {
  const [row] = await db
    .select({ cap: sql<string>`COALESCE(MAX(${roleDiscountCapsTable.max_discount_percent}), 0)` })
    .from(roleDiscountCapsTable)
    .where(eq(roleDiscountCapsTable.can_approve, true));
  return Number(row?.cap ?? 0);
}

export async function findAllCaps() {
  return db.select().from(roleDiscountCapsTable);
}

export async function upsertCap(
  roleId: number,
  percent: string,
  canApprove: boolean,
  userId: number | null,
): Promise<void> {
  await db
    .insert(roleDiscountCapsTable)
    .values({
      role_id: roleId,
      max_discount_percent: percent,
      can_approve: canApprove,
      updated_by: userId,
    })
    .onConflictDoUpdate({
      target: roleDiscountCapsTable.role_id,
      set: {
        max_discount_percent: percent,
        can_approve: canApprove,
        updated_by: userId,
        updated_at: new Date(),
      },
    });
}

// ── رصيد الزبون ─────────────────────────────────────────────────────────────

/** الرصيد **مجموع الدفتر** لا عمودٌ يُحدَّث: عمودٌ يفقد «لماذا صار كذا». */
export async function findCustomerBalance(customerId: number, exec: Exec = db): Promise<number> {
  const [row] = await exec
    .select({ total: sql<string>`COALESCE(SUM(${customerLedgerTable.amount_syp}), 0)` })
    .from(customerLedgerTable)
    .where(eq(customerLedgerTable.customer_id, customerId));
  return Number(row?.total ?? 0);
}

export async function findCreditLimit(customerId: number): Promise<number | null> {
  const [row] = await db
    .select({ limit: customerCreditLimitsTable.limit_syp })
    .from(customerCreditLimitsTable)
    .where(eq(customerCreditLimitsTable.customer_id, customerId))
    .limit(1);
  return row === undefined ? null : Number(row.limit);
}

export async function upsertCreditLimit(
  customerId: number,
  limit: string,
  userId: number | null,
): Promise<void> {
  await db
    .insert(customerCreditLimitsTable)
    .values({ customer_id: customerId, limit_syp: limit, updated_by: userId })
    .onConflictDoUpdate({
      target: customerCreditLimitsTable.customer_id,
      set: { limit_syp: limit, updated_by: userId, updated_at: new Date() },
    });
}

export async function insertLedgerEntries(
  exec: Exec,
  rows: (typeof customerLedgerTable.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(customerLedgerTable).values(rows);
}

export async function findLedger(customerId: number, limit: number) {
  return db
    .select()
    .from(customerLedgerTable)
    .where(eq(customerLedgerTable.customer_id, customerId))
    .orderBy(desc(customerLedgerTable.created_at), desc(customerLedgerTable.id))
    .limit(limit);
}

// ── ما يحتاجه السطر ليُكتب لقطةً ────────────────────────────────────────────

/**
 * ما يصلح لسطر بيع — بحثاً بالاسم أو الـSKU أو **الباركود تماماً**.
 *
 * يعيش هنا لا بموديول الكتالوج: نقطة البيع تحتاج صفّاً بسعره ورصيده، وقراءة
 * **جدول** موديول آخر مسموحة بينما قراءة خدمته ليست (نفس حلّ
 * `GET /inventory/document-items` و`GET /promotions/targets`).
 *
 * **والباركود يُطابَق تماماً لا جزئياً**: `ILIKE %code%` يجعل مسحة `123`
 * تعرض كل رمزٍ يحتويها، والكاشير يختار من قائمةٍ بدل أن يمضي.
 */
export async function searchSellableItems(
  search: string,
  branchId: number,
  limit: number,
): Promise<
  {
    variant_id: number;
    product_id: number;
    sku: string;
    product_name_ar: string;
    base_unit_id: number;
    on_hand: string | null;
    exact_barcode: boolean;
  }[]
> {
  const term = `%${search}%`;
  return db
    .select({
      variant_id: catalogVariantsTable.id,
      product_id: catalogProductsTable.id,
      sku: catalogVariantsTable.sku,
      product_name_ar: catalogProductsTable.name_ar,
      base_unit_id: catalogVariantsTable.base_unit_id,
      on_hand: stockBalancesTable.on_hand,
      exact_barcode: sql<boolean>`EXISTS (
        SELECT 1 FROM catalog_barcodes b
        JOIN catalog_variant_units vu ON vu.id = b.variant_unit_id
        WHERE vu.variant_id = ${catalogVariantsTable.id} AND b.code = ${search})`,
    })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .leftJoin(
      stockBalancesTable,
      and(
        eq(stockBalancesTable.variant_id, catalogVariantsTable.id),
        eq(stockBalancesTable.branch_id, branchId),
      ),
    )
    .where(
      and(
        isNull(catalogProductsTable.archived_at),
        // المسحوب من البيع لا يُعرض للكاشير إطلاقاً: صفٌّ يُختار ثم يُرفض
        // عند الإضافة يوقف الطابور مرتين.
        eq(catalogProductsTable.status, 'active'),
        sql`(${catalogProductsTable.search_text} ILIKE ${term}
          OR ${catalogVariantsTable.sku} ILIKE ${term}
          OR EXISTS (
            SELECT 1 FROM catalog_barcodes b
            JOIN catalog_variant_units vu ON vu.id = b.variant_unit_id
            WHERE vu.variant_id = ${catalogVariantsTable.id} AND b.code = ${search}))`,
      ),
    )
    .orderBy(asc(catalogProductsTable.name_ar), asc(catalogVariantsTable.id))
    .limit(limit);
}

export async function findVariantForSale(variantId: number) {
  const [row] = await db
    .select({
      variant_id: catalogVariantsTable.id,
      product_id: catalogProductsTable.id,
      name_ar: catalogProductsTable.name_ar,
      sku: catalogVariantsTable.sku,
      category_id: catalogProductsTable.category_id,
      base_unit_id: catalogVariantsTable.base_unit_id,
      status: catalogProductsTable.status,
    })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogVariantsTable.product_id, catalogProductsTable.id))
    .where(eq(catalogVariantsTable.id, variantId))
    .limit(1);
  return row;
}
