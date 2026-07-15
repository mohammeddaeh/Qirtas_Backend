import { eq } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import { branchesTable, type BranchRow, type NewBranchRow } from '../schemas/branches.schema.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';

export function findMany(params: PaginationParams): Promise<{ rows: BranchRow[]; total: number }> {
  return findManyPaginated<BranchRow>(branchesTable, params);
}

export function findById(id: number): Promise<BranchRow | undefined> {
  return findOneById<BranchRow>(branchesTable, branchesTable.id, id);
}

export async function insert(data: NewBranchRow): Promise<BranchRow> {
  const rows = await db.insert(branchesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function update(
  id: number,
  data: Partial<NewBranchRow>,
): Promise<BranchRow | undefined> {
  const rows = await db.update(branchesTable).set(data).where(eq(branchesTable.id, id)).returning();
  return rows[0];
}
