import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { financeEntriesTable } from '../../../core/finance/schemas/finance-entries.schema.js';
import { cashMovementsTable, cashShiftsTable, type CashShiftRow } from '../schemas/shifts.schema.js';
import { salesTable } from '../schemas/sales.schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

/**
 * The branch's open shift — one drawer per branch. `undefined` when none.
 *
 * [lock] `share` inside a payment: a close holds the row `for update`, so a
 * payment racing it waits, then re-reads the row as closed and finds nothing —
 * money is never stamped on a shift that has been counted.
 */
export async function findOpenShift(exec: Exec, branchId: number, lock?: 'share'): Promise<CashShiftRow | undefined> {
  const query = exec
    .select()
    .from(cashShiftsTable)
    .where(and(eq(cashShiftsTable.branch_id, branchId), eq(cashShiftsTable.status, 'open')))
    .limit(1);
  const [row] = lock === 'share' ? await query.for('share') : await query;
  return row;
}

export async function findShiftById(exec: Exec, id: number): Promise<CashShiftRow | undefined> {
  const [row] = await exec.select().from(cashShiftsTable).where(eq(cashShiftsTable.id, id));
  return row;
}

/** Locks the shift row for a close — two closes of one shift must not both count it. */
export async function lockShift(tx: Tx, id: number): Promise<CashShiftRow | undefined> {
  const [row] = await tx.select().from(cashShiftsTable).where(eq(cashShiftsTable.id, id)).for('update');
  return row;
}

/** What the last close left in the branch's drawer — the opening to suggest. */
export async function findLastLeft(branchId: number): Promise<number | null> {
  const [row] = await db
    .select({ left: cashShiftsTable.left_in_drawer_syp })
    .from(cashShiftsTable)
    .where(
      and(
        eq(cashShiftsTable.branch_id, branchId),
        eq(cashShiftsTable.status, 'closed'),
        isNotNull(cashShiftsTable.left_in_drawer_syp),
      ),
    )
    .orderBy(desc(cashShiftsTable.closed_at))
    .limit(1);
  return row?.left == null ? null : Number(row.left);
}

/** The dollars the last close left in this drawer — `null` when none were left on record. */
export async function findLastLeftUsd(branchId: number): Promise<number | null> {
  const [row] = await db
    .select({ left: cashShiftsTable.left_in_drawer_usd })
    .from(cashShiftsTable)
    .where(
      and(
        eq(cashShiftsTable.branch_id, branchId),
        eq(cashShiftsTable.status, 'closed'),
        isNotNull(cashShiftsTable.left_in_drawer_usd),
      ),
    )
    .orderBy(desc(cashShiftsTable.closed_at))
    .limit(1);
  return row?.left == null ? null : Number(row.left);
}

export async function insertShift(tx: Tx, values: typeof cashShiftsTable.$inferInsert): Promise<CashShiftRow> {
  const [row] = await tx.insert(cashShiftsTable).values(values).returning();
  return row!;
}

export async function updateShift(tx: Tx, id: number, values: Partial<typeof cashShiftsTable.$inferInsert>): Promise<void> {
  await tx.update(cashShiftsTable).set(values).where(eq(cashShiftsTable.id, id));
}

export async function insertMovement(tx: Tx, values: typeof cashMovementsTable.$inferInsert) {
  const [row] = await tx.insert(cashMovementsTable).values(values).returning();
  return row!;
}

export async function findMovementById(exec: Exec, id: number) {
  const [row] = await exec.select().from(cashMovementsTable).where(eq(cashMovementsTable.id, id));
  return row;
}

/** The movement that already reverses [movementId] — a movement is reversed once. */
export async function findReversalOf(exec: Exec, movementId: number) {
  const [row] = await exec
    .select({ id: cashMovementsTable.id })
    .from(cashMovementsTable)
    .where(eq(cashMovementsTable.reverses_movement_id, movementId))
    .limit(1);
  return row;
}

/**
 * Carts parked at the branch — warned about at close, they are not money. The
 * cart being built is left out: the till's own «parked (1)» counts the same,
 * and two numbers for one thing read as one of them wrong.
 */
export async function countOpenCarts(branchId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(salesTable)
    .where(and(eq(salesTable.branch_id, branchId), eq(salesTable.status, 'held')));
  return row?.n ?? 0;
}

/** Every money entry of the shift with who booked it and where — the report's per-person table. */
export async function findPersonEntries(shiftId: number) {
  const rows = await db
    .select({
      userId: financeEntriesTable.user_id,
      stationId: financeEntriesTable.station_id,
      type: financeEntriesTable.type,
      method: financeEntriesTable.method,
      amount: financeEntriesTable.amount_syp,
      docType: financeEntriesTable.doc_type,
      docId: financeEntriesTable.doc_id,
    })
    .from(financeEntriesTable)
    .where(eq(financeEntriesTable.shift_id, shiftId));
  return rows.map((r) => ({ ...r, amountSyp: Number(r.amount) }));
}

export async function findMovements(shiftId: number) {
  return db
    .select()
    .from(cashMovementsTable)
    .where(eq(cashMovementsTable.shift_id, shiftId))
    .orderBy(cashMovementsTable.created_at);
}

/** Every cash-method entry of the shift — the expected cash is their sum. */
export async function findCashEntries(
  exec: Exec,
  shiftId: number,
): Promise<{ type: string; amountSyp: number; currency: string; amountFx: number | null }[]> {
  const rows = await exec
    .select({
      type: financeEntriesTable.type,
      amount: financeEntriesTable.amount_syp,
      currency: financeEntriesTable.currency,
      fx: financeEntriesTable.amount_fx,
    })
    .from(financeEntriesTable)
    .where(and(eq(financeEntriesTable.shift_id, shiftId), eq(financeEntriesTable.method, 'cash')));
  return rows.map((r) => ({
    type: r.type,
    amountSyp: Number(r.amount),
    currency: r.currency,
    amountFx: r.fx === null ? null : Number(r.fx),
  }));
}

/** The shift's money by type and method — the report's totals. */
export async function findTotalsByTypeMethod(shiftId: number) {
  const rows = await db
    .select({
      type: financeEntriesTable.type,
      method: financeEntriesTable.method,
      total: sql<string>`sum(${financeEntriesTable.amount_syp})`,
    })
    .from(financeEntriesTable)
    .where(and(eq(financeEntriesTable.shift_id, shiftId), ne(financeEntriesTable.method, 'value')))
    .groupBy(financeEntriesTable.type, financeEntriesTable.method);
  return rows.map((r) => ({ type: r.type, method: r.method, totalSyp: Number(r.total) }));
}

/** Paid invoices in the shift — counted once each, whatever their payment split. */
export async function countSales(shiftId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${financeEntriesTable.sale_id})::int` })
    .from(financeEntriesTable)
    .where(and(eq(financeEntriesTable.shift_id, shiftId), eq(financeEntriesTable.type, 'sale_revenue')));
  return row?.n ?? 0;
}

export async function findShifts(
  filters: {
    branchIds: number[];
    cashierUserId?: number;
    status?: 'open' | 'closed';
    from?: Date;
    to?: Date;
    withDifference?: boolean;
    needsReview?: boolean;
  },
  limit: number,
  offset: number,
): Promise<{ rows: CashShiftRow[]; total: number }> {
  if (filters.branchIds.length === 0) return { rows: [], total: 0 };
  const clause = shiftsWhere(filters);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(cashShiftsTable)
      .where(clause)
      // Open first (still to count), then the ones waiting for a review, then newest.
      .orderBy(
        sql`${cashShiftsTable.status} = 'closed'`,
        sql`not (${cashShiftsTable.needs_review} and ${cashShiftsTable.reviewed_at} is null)`,
        desc(cashShiftsTable.opened_at),
      )
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(cashShiftsTable).where(clause),
  ]);
  return { rows, total: totalRow?.value ?? 0 };
}

/** The line above the manager's list: how many came out off, and by how much each way. */
export async function findShiftsSummary(filters: Parameters<typeof shiftsWhere>[0]) {
  if (filters.branchIds.length === 0) return { withDifference: 0, waitingReview: 0, shortSyp: 0, overSyp: 0 };
  const [row] = await db
    .select({
      withDifference: sql<number>`count(*) filter (where coalesce(${cashShiftsTable.difference_syp}, 0) <> 0)::int`,
      waitingReview: sql<number>`count(*) filter (where ${cashShiftsTable.needs_review} and ${cashShiftsTable.reviewed_at} is null)::int`,
      shortSyp: sql<string>`coalesce(sum(${cashShiftsTable.difference_syp}) filter (where ${cashShiftsTable.difference_syp} < 0), 0)`,
      overSyp: sql<string>`coalesce(sum(${cashShiftsTable.difference_syp}) filter (where ${cashShiftsTable.difference_syp} > 0), 0)`,
    })
    .from(cashShiftsTable)
    .where(shiftsWhere(filters));
  return {
    withDifference: row?.withDifference ?? 0,
    waitingReview: row?.waitingReview ?? 0,
    shortSyp: -Number(row?.shortSyp ?? 0),
    overSyp: Number(row?.overSyp ?? 0),
  };
}

function shiftsWhere(filters: {
  branchIds: number[];
  cashierUserId?: number;
  status?: 'open' | 'closed';
  from?: Date;
  to?: Date;
  withDifference?: boolean;
  needsReview?: boolean;
}): SQL | undefined {
  const where: SQL[] = [inArray(cashShiftsTable.branch_id, filters.branchIds)];
  if (filters.cashierUserId !== undefined) where.push(eq(cashShiftsTable.cashier_user_id, filters.cashierUserId));
  if (filters.status !== undefined) where.push(eq(cashShiftsTable.status, filters.status));
  if (filters.from !== undefined) where.push(gte(cashShiftsTable.opened_at, filters.from));
  if (filters.to !== undefined) where.push(lt(cashShiftsTable.opened_at, filters.to));
  if (filters.withDifference) where.push(sql`coalesce(${cashShiftsTable.difference_syp}, 0) <> 0`);
  if (filters.needsReview) where.push(sql`${cashShiftsTable.needs_review} and ${cashShiftsTable.reviewed_at} is null`);
  return and(...where);
}

/** Branches still in service — the manager's shift list is scoped within them. */
export async function findLiveBranchIds(): Promise<number[]> {
  const rows = await db.select({ id: branchesTable.id }).from(branchesTable).where(isNull(branchesTable.archived_at));
  return rows.map((r) => r.id);
}
