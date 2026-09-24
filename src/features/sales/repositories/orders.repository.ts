import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { customersTable } from '../../customers/schemas/customers.schema.js';
import { catalogProductsTable, catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { stockBalancesTable } from '../../inventory/schemas/stock.schema.js';
import {
  cartLinesTable,
  cartsTable,
  orderLinesTable,
  orderSequencesTable,
  ordersTable,
  type CartRow,
  type OrderRow,
} from '../schemas/orders.schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

/**
 * الزبون كما يحتاجه الطلب: اسمه بالفاتورة، وفئته للتسعير.
 *
 * **الجملة تُقرأ من الصفّ لا من الجلسة**: موافقةٌ تُسحب وصاحبها يتصفّح يجب أن
 * تسري بالشاشة التالية، وعلمٌ مخبّأ بالجلسة يُبقي خصماً مسحوباً حيّاً أياماً.
 */
export async function findCustomer(
  customerId: number,
): Promise<{ id: number; name: string; is_wholesale: boolean; status: string } | undefined> {
  const [row] = await db
    .select({
      id: customersTable.id,
      first_name: customersTable.first_name,
      last_name: customersTable.last_name,
      customer_type: customersTable.customer_type,
      status: customersTable.status,
    })
    .from(customersTable)
    .where(eq(customersTable.id, customerId))
    .limit(1);
  if (!row) return undefined;
  return {
    id: row.id,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
    is_wholesale: row.customer_type === 'wholesale',
    status: row.status,
  };
}

/** الفرع الذي يُنفّذ الطلب — مغلقاً أو مؤرشفاً لا يُستلم منه شيء. */
export async function findShoppableBranch(
  branchId: number,
): Promise<{ id: number; name: string } | undefined> {
  const [row] = await db
    .select({
      id: branchesTable.id,
      name: branchesTable.name,
      status: branchesTable.status,
      archived_at: branchesTable.archived_at,
    })
    .from(branchesTable)
    .where(eq(branchesTable.id, branchId))
    .limit(1);
  if (!row || row.archived_at !== null || row.status !== 'active') return undefined;
  return { id: row.id, name: row.name };
}

// ── السلّة ──────────────────────────────────────────────────────────────────

/**
 * سلّة هذا الزبون بهذا الفرع — **تُنشأ بأول قراءة**.
 *
 * بلا ذلك تعود «لا سلّة» لمن لم يضف شيئاً بعد، فتضطر كل شاشة أن تميّز
 * «فارغة» عن «غير موجودة» — وهما الشيء نفسه للزبون.
 */
export async function findOrCreateCart(customerId: number, branchId: number): Promise<CartRow> {
  const [row] = await db
    .select()
    .from(cartsTable)
    .where(and(eq(cartsTable.customer_id, customerId), eq(cartsTable.branch_id, branchId)))
    .limit(1);
  if (row) return row;
  await db
    .insert(cartsTable)
    .values({ customer_id: customerId, branch_id: branchId })
    .onConflictDoNothing();
  const [created] = await db
    .select()
    .from(cartsTable)
    .where(and(eq(cartsTable.customer_id, customerId), eq(cartsTable.branch_id, branchId)))
    .limit(1);
  return created!;
}

export async function findCartLines(cartId: number, exec: Exec = db) {
  return exec
    .select({
      id: cartLinesTable.id,
      variant_id: cartLinesTable.variant_id,
      qty: cartLinesTable.qty,
      product_id: catalogProductsTable.id,
      name_ar: catalogProductsTable.name_ar,
      sku: catalogVariantsTable.sku,
      status: catalogProductsTable.status,
    })
    .from(cartLinesTable)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, cartLinesTable.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(eq(cartLinesTable.cart_id, cartId))
    .orderBy(cartLinesTable.id);
}

/** المتاح لكل صنف بهذا الفرع — `on_hand − reserved` كما يراه الكاشير. */
export async function findAvailable(
  branchId: number,
  variantIds: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (variantIds.length === 0) return out;
  const rows = await db
    .select({
      variant_id: stockBalancesTable.variant_id,
      available: sql<string>`${stockBalancesTable.on_hand} - ${stockBalancesTable.reserved}`,
    })
    .from(stockBalancesTable)
    .where(
      and(
        eq(stockBalancesTable.branch_id, branchId),
        inArray(stockBalancesTable.variant_id, variantIds),
      ),
    );
  for (const row of rows) out.set(row.variant_id, Number(row.available));
  return out;
}

export async function upsertCartLine(cartId: number, variantId: number, qty: number): Promise<void> {
  await db
    .insert(cartLinesTable)
    .values({ cart_id: cartId, variant_id: variantId, qty: String(qty) })
    .onConflictDoUpdate({
      target: [cartLinesTable.cart_id, cartLinesTable.variant_id],
      // **الإضافة ترفع الكمية**: سطران بخمسة يفوّتان شريحة العشرة.
      set: { qty: sql`${cartLinesTable.qty} + ${String(qty)}` },
    });
}

export async function setCartLineQty(cartId: number, variantId: number, qty: number): Promise<void> {
  await db
    .update(cartLinesTable)
    .set({ qty: String(qty) })
    .where(and(eq(cartLinesTable.cart_id, cartId), eq(cartLinesTable.variant_id, variantId)));
}

export async function deleteCartLine(cartId: number, variantId: number): Promise<void> {
  await db
    .delete(cartLinesTable)
    .where(and(eq(cartLinesTable.cart_id, cartId), eq(cartLinesTable.variant_id, variantId)));
}

export async function clearCart(exec: Exec, cartId: number): Promise<void> {
  await exec.delete(cartLinesTable).where(eq(cartLinesTable.cart_id, cartId));
}

// ── الطلب ───────────────────────────────────────────────────────────────────

export async function nextOrderSequence(exec: Exec, branchId: number, year: number): Promise<number> {
  const result = await exec.execute(
    sql`INSERT INTO ${orderSequencesTable} (branch_id, year, last_sequence)
        VALUES (${branchId}, ${year}, 1)
        ON CONFLICT (branch_id, year)
        DO UPDATE SET last_sequence = ${orderSequencesTable}.last_sequence + 1
        RETURNING last_sequence`,
  );
  const list =
    (result as unknown as { rows?: { last_sequence: number }[] }).rows ??
    (result as unknown as { last_sequence: number }[]);
  return Number(list[0]?.last_sequence ?? 1);
}

export async function insertOrder(
  exec: Exec,
  values: typeof ordersTable.$inferInsert,
): Promise<OrderRow> {
  const [row] = await exec.insert(ordersTable).values(values).returning();
  return row!;
}

export async function insertOrderLines(
  exec: Exec,
  rows: (typeof orderLinesTable.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(orderLinesTable).values(rows);
}

export async function findOrderById(id: number, exec: Exec = db): Promise<OrderRow | undefined> {
  const [row] = await exec.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  return row;
}

/** الصفّ مقفلاً — بينه وبين تغيير الحالة لا يُسلَّم الطلب مرتين. */
export async function lockOrder(exec: Exec, id: number): Promise<OrderRow | undefined> {
  const rows = await exec.execute(
    sql`SELECT * FROM ${ordersTable} WHERE ${ordersTable.id} = ${id} FOR UPDATE`,
  );
  const list = (rows as unknown as { rows?: OrderRow[] }).rows ?? (rows as unknown as OrderRow[]);
  return list[0];
}

/** الطلب المرتبط بهذه الفاتورة — به يُغلق الطلب حين تُسدَّد، لا بنداء ثانٍ. */
export async function findOrderBySaleId(saleId: number, exec: Exec = db): Promise<OrderRow | undefined> {
  const [row] = await exec.select().from(ordersTable).where(eq(ordersTable.sale_id, saleId)).limit(1);
  return row;
}

export async function updateOrder(
  exec: Exec,
  id: number,
  values: Partial<typeof ordersTable.$inferInsert>,
): Promise<void> {
  await exec.update(ordersTable).set(values).where(eq(ordersTable.id, id));
}

export async function findOrderLines(orderId: number, exec: Exec = db) {
  return exec
    .select()
    .from(orderLinesTable)
    .where(eq(orderLinesTable.order_id, orderId))
    .orderBy(orderLinesTable.id);
}

export async function findOrders(
  filters: { branchId?: number; customerId?: number; status?: OrderRow['status'] },
  limit: number,
  offset: number,
): Promise<{ rows: OrderRow[]; total: number }> {
  const clauses = [];
  if (filters.branchId !== undefined) clauses.push(eq(ordersTable.branch_id, filters.branchId));
  if (filters.customerId !== undefined) clauses.push(eq(ordersTable.customer_id, filters.customerId));
  if (filters.status !== undefined) clauses.push(eq(ordersTable.status, filters.status));
  const where = clauses.length > 0 ? and(...clauses) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(ordersTable)
      .where(where)
      .orderBy(desc(ordersTable.created_at), desc(ordersTable.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<string>`count(*)` }).from(ordersTable).where(where),
  ]);
  return { rows, total: Number(counted[0]?.count ?? 0) };
}

/**
 * الطلبات التي سقطت مهلتها — **بحدٍّ أعلى**.
 *
 * كنسةٌ بلا حدّ بعد انقطاعٍ طويل تقفل آلاف الصفوف بمعاملة واحدة وتُعلّق أول
 * طلبٍ يفتح الشاشة بعدها.
 */
export async function findExpiredOrders(now: Date, limit: number): Promise<OrderRow[]> {
  return db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.status, 'pending_pickup'),
        sql`${ordersTable.reserved_until} IS NOT NULL`,
        lte(ordersTable.reserved_until, now),
      ),
    )
    .limit(limit);
}
