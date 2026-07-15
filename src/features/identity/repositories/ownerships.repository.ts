import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findOneById } from '../../../core/db/crud-helpers.js';
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
