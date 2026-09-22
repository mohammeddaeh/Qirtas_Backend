import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findOneById } from '../../../core/db/crud-helpers.js';
import { usersTable } from '../schemas/users.schema.js';
import { branchesTable } from '../schemas/branches.schema.js';
import {
  ownershipsTable,
  type OwnershipRow,
  type NewOwnershipRow,
} from '../schemas/ownerships.schema.js';

const isActiveClause = sql`(${ownershipsTable.valid_to} IS NULL OR ${ownershipsTable.valid_to} > now())`;

export function findById(id: number): Promise<OwnershipRow | undefined> {
  return findOneById<OwnershipRow>(ownershipsTable, ownershipsTable.id, id);
}

export async function findActiveByScope(branchScope: number | null): Promise<OwnershipRow[]> {
  const scopeClause =
    branchScope === null
      ? sql`${ownershipsTable.branch_scope} IS NULL`
      : eq(ownershipsTable.branch_scope, branchScope);
  return db.select().from(ownershipsTable).where(and(scopeClause, isActiveClause));
}

/** Sum of active percentages for a scope, used by the 100%-cap guard (excludes a given ownership id when editing). */
/** A row with the names it points at — see [WireOwnership.user_name]. */
export interface OwnershipWithNamesRow {
  row: OwnershipRow;
  user_name: string;
  branch_name: string | null;
}

/**
 * Every active record, or one branch's. `branchScope` undefined = everything.
 * `leftJoin` on branches: the all-branches scope has no branch to name.
 */
export async function findActiveWithNames(branchScope?: number): Promise<OwnershipWithNamesRow[]> {
  const rows = await db
    .select({
      row: ownershipsTable,
      first: usersTable.first_name,
      last: usersTable.last_name,
      branch: branchesTable.name,
    })
    .from(ownershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, ownershipsTable.user_id))
    .leftJoin(branchesTable, eq(branchesTable.id, ownershipsTable.branch_scope))
    .where(
      and(
        isActiveClause,
        branchScope === undefined ? sql`true` : eq(ownershipsTable.branch_scope, branchScope),
      ),
    )
    .orderBy(ownershipsTable.branch_scope, desc(ownershipsTable.percentage));
  return rows.map((r) => ({
    row: r.row,
    user_name: `${r.first} ${r.last}`.trim(),
    branch_name: r.branch,
  }));
}

export async function findWithNamesById(id: number): Promise<OwnershipWithNamesRow | undefined> {
  const rows = await db
    .select({
      row: ownershipsTable,
      first: usersTable.first_name,
      last: usersTable.last_name,
      branch: branchesTable.name,
    })
    .from(ownershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, ownershipsTable.user_id))
    .leftJoin(branchesTable, eq(branchesTable.id, ownershipsTable.branch_scope))
    .where(eq(ownershipsTable.id, id))
    .limit(1);
  const r = rows[0];
  return r && { row: r.row, user_name: `${r.first} ${r.last}`.trim(), branch_name: r.branch };
}

export async function sumActivePercentage(
  branchScope: number | null,
  excludingId?: number,
): Promise<number> {
  const scopeClause =
    branchScope === null
      ? sql`${ownershipsTable.branch_scope} IS NULL`
      : eq(ownershipsTable.branch_scope, branchScope);
  const excludeClause = excludingId ? sql`${ownershipsTable.id} != ${excludingId}` : sql`true`;

  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${ownershipsTable.percentage}), 0)` })
    .from(ownershipsTable)
    .where(and(scopeClause, isActiveClause, excludeClause));

  return Number(rows[0]?.total ?? 0);
}

// ─── Retirement counts ───────────────────────────────────────────────────────
//
// The second thing that can point at a branch or a person, and the one that is
// easy to forget: `ownerships.branch_scope` is `RESTRICT` exactly like an
// assignment's `branch_id`, so a branch nobody was ever *staffed* in can still
// be undeletable because somebody owned a share of it. Checking assignments
// alone would let the service promise a delete that the database then refuses
// as a raw constraint error.
//
// `branch_scope IS NULL` means "all branches" — such a row belongs to no branch
// in particular and is never counted against one.

export async function countEverForBranch(branchScope: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(ownershipsTable)
    .where(eq(ownershipsTable.branch_scope, branchScope));
  return Number(rows[0]?.value ?? 0);
}

export async function countOpenForBranch(branchScope: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(ownershipsTable)
    .where(and(eq(ownershipsTable.branch_scope, branchScope), isActiveClause));
  return Number(rows[0]?.value ?? 0);
}

export async function countEverForUser(userId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(ownershipsTable)
    .where(eq(ownershipsTable.user_id, userId));
  return Number(rows[0]?.value ?? 0);
}

export async function countOpenForUser(userId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(ownershipsTable)
    .where(and(eq(ownershipsTable.user_id, userId), isActiveClause));
  return Number(rows[0]?.value ?? 0);
}

export async function insert(data: NewOwnershipRow): Promise<OwnershipRow> {
  const rows = await db.insert(ownershipsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function closeOwnership(id: number, validTo: Date): Promise<OwnershipRow | undefined> {
  const rows = await db
    .update(ownershipsTable)
    .set({ valid_to: validTo })
    .where(eq(ownershipsTable.id, id))
    .returning();
  return rows[0];
}
