import { eq, count, ne, and } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import { usersTable, type UserRow, type NewUserRow } from '../schemas/users.schema.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';

export function findMany(params: PaginationParams): Promise<{ rows: UserRow[]; total: number }> {
  return findManyPaginated<UserRow>(usersTable, params);
}

export function findById(id: number): Promise<UserRow | undefined> {
  return findOneById<UserRow>(usersTable, usersTable.id, id);
}

export async function findByEmail(email: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  return rows[0];
}

/** Excludes a given user id — used when checking the cross-table (User+Customer) email uniqueness on update flows. */
export async function existsByEmailExcluding(email: string, excludingId: number): Promise<boolean> {
  const rows = await db
    .select({ value: count() })
    .from(usersTable)
    .where(and(eq(usersTable.email, email), ne(usersTable.id, excludingId)));
  return (rows[0]?.value ?? 0) > 0;
}

export async function countAll(): Promise<number> {
  const rows = await db.select({ value: count() }).from(usersTable);
  return rows[0]?.value ?? 0;
}

export async function insert(data: NewUserRow): Promise<UserRow> {
  const rows = await db.insert(usersTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function update(id: number, data: Partial<NewUserRow>): Promise<UserRow | undefined> {
  const rows = await db.update(usersTable).set(data).where(eq(usersTable.id, id)).returning();
  return rows[0];
}
