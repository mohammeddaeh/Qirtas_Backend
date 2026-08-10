import { eq, count, ne, and, asc, desc, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import { likeTerm } from '../../../core/db/like-term.js';
import { usersTable, type UserRow, type NewUserRow } from '../schemas/users.schema.js';
import { userRoleAssignmentsTable } from '../schemas/user-role-assignments.schema.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import type { UsersFilterQuery } from '../dtos/users.dto.js';

const sortColumns = {
  created_at: usersTable.created_at,
  first_name: usersTable.first_name,
} as const;

export function findMany(
  params: PaginationParams,
  filter: UsersFilterQuery,
): Promise<{ rows: UserRow[]; total: number }> {
  const conditions: SQL[] = [];
  if (filter.status !== undefined) conditions.push(eq(usersTable.status, filter.status));
  if (filter.is_admin !== undefined) conditions.push(eq(usersTable.is_admin, filter.is_admin));
  if (filter.requested_role_id !== undefined) {
    conditions.push(eq(usersTable.requested_role_id, filter.requested_role_id));
  }
  if (filter.unassigned !== undefined) {
    // Correlated EXISTS rather than a join: a join would duplicate a user row
    // per assignment and break both the page size and the total count.
    const holdsActiveAssignment = sql`EXISTS (
      SELECT 1 FROM ${userRoleAssignmentsTable} a
      WHERE a.user_id = ${usersTable.id}
        AND (a.valid_to IS NULL OR a.valid_to > now())
    )`;
    conditions.push(filter.unassigned ? sql`NOT ${holdsActiveAssignment}` : holdsActiveAssignment);
  }
  if (filter.search !== undefined && filter.search.length > 0) {
    // Matched against the CONCATENATED name, so "أحمد العبدالله" finds the
    // person whose first and last names are stored separately — searching the
    // columns individually never would.
    const term = likeTerm(filter.search);
    conditions.push(
      sql`(
        ${usersTable.first_name} || ' ' || ${usersTable.last_name} ILIKE ${term}
        OR ${usersTable.email} ILIKE ${term}
        OR ${usersTable.phone} ILIKE ${term}
      )`,
    );
  }

  const orderFn = filter.sort_dir === 'asc' ? asc : desc;

  return findManyPaginated<UserRow>(usersTable, params, {
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: orderFn(sortColumns[filter.sort_by]),
  });
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
