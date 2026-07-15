import { count, eq, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from './client.js';
import type { PaginationParams } from '../pagination/pagination.js';

/**
 * Shared implementation of the two repository queries that are byte-for-byte
 * identical across every feature (list + getById) — see
 * src/core/CLAUDE.md §CRUD. Every other repository function
 * (findByName, countActive, replacePermissions, ...) stays hand-written:
 * only list/getById repeat verbatim across modules, nothing else does.
 *
 * Usage in a repository file:
 *   export function findMany(params: PaginationParams) {
 *     return findManyPaginated(branchesTable, params);
 *   }
 *   export function findById(id: number) {
 *     return findOneById(branchesTable, branchesTable.id, id);
 *   }
 *
 * `where`/`orderBy` are optional escape hatches for modules that need extra
 * filtering or ordering on top of the identical list/count shape (e.g.
 * audit-log-entries) — the paging + count-total mechanics stay shared.
 */

export async function findManyPaginated<TRow>(
  table: PgTable,
  params: PaginationParams,
  options?: { where?: SQL; orderBy?: SQL },
): Promise<{ rows: TRow[]; total: number }> {
  const [rows, totalResult] = await Promise.all([
    db
      .select()
      .from(table)
      .where(options?.where)
      .orderBy(...(options?.orderBy ? [options.orderBy] : []))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ value: count() }).from(table).where(options?.where),
  ]);
  return { rows: rows as TRow[], total: totalResult[0]?.value ?? 0 };
}

export async function findOneById<TRow>(
  table: PgTable,
  idColumn: AnyPgColumn,
  id: number,
): Promise<TRow | undefined> {
  const rows = await db.select().from(table).where(eq(idColumn, id)).limit(1);
  return rows[0] as TRow | undefined;
}
