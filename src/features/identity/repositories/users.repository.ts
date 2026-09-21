import { eq, count, ne, and, asc, desc, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import { likeTerm } from '../../../core/db/like-term.js';
import { usersTable, type UserRow, type NewUserRow } from '../schemas/users.schema.js';
import { userRoleAssignmentsTable } from '../schemas/user-role-assignments.schema.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import type { UsersFilterQuery } from '../dtos/users.dto.js';
import * as accountEmails from '../../../core/auth/repositories/account-emails.repository.js';

const sortColumns = {
  created_at: usersTable.created_at,
  first_name: usersTable.first_name,
} as const;

export function findMany(
  params: PaginationParams,
  filter: UsersFilterQuery,
): Promise<{ rows: UserRow[]; total: number }> {
  const conditions: SQL[] = [];
  // Always applied: `archived` picks which set is being browsed, and every
  // other filter narrows inside it. An archived account is `disabled` too, so
  // without this the "معطَّل" status filter would quietly resurface every
  // account an admin has retired.
  conditions.push(
    filter.archived === true
      ? sql`${usersTable.archived_at} IS NOT NULL`
      : sql`${usersTable.archived_at} IS NULL`,
  );
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
  if (filter.excluding_role_id !== undefined) {
    // The (role, branch) pair, matched exactly. `IS NOT DISTINCT FROM` rather
    // than `=` because the unrestricted post is `branch_id IS NULL`, and `=
    // NULL` is never true in SQL — so an unrestricted post would exclude nobody
    // and the picker would keep offering a duplicate the server then refuses.
    const branchId = filter.excluding_branch_id ?? null;
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${userRoleAssignmentsTable} a
      WHERE a.user_id = ${usersTable.id}
        AND a.role_id = ${filter.excluding_role_id}
        AND a.branch_id IS NOT DISTINCT FROM ${branchId}
        AND (a.valid_to IS NULL OR a.valid_to > now())
    )`);
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

/** People on the books — archived accounts excluded, so the dashboard's headcount matches the list it links to. */
export async function countAll(): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(usersTable)
    .where(sql`${usersTable.archived_at} IS NULL`);
  return rows[0]?.value ?? 0;
}

/**
 * Destroys the row. Reachable only after the service has established that this
 * account has no assignment, no ownership and no audit entry to its name.
 *
 * `user_role_assignments` and `ownerships` cascade, so the check is what stops
 * a "delete" from silently taking someone's employment record with it — the
 * database would not object. `audit_log_entries.user_id` is `RESTRICT` and does
 * object, which is why it is checked first and named in the refusal.
 */
export async function deleteById(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(usersTable).where(eq(usersTable.id, id));
    await accountEmails.release(tx, 'staff', id);
  });
}

export async function insert(data: NewUserRow): Promise<UserRow> {
  // The cross-realm email claim commits with the row it describes — see
  // `account_emails`. A duplicate in either realm rolls both back (23505).
  return db.transaction(async (tx) => {
    const rows = await tx.insert(usersTable).values(data).returning();
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    await accountEmails.claim(tx, 'staff', row.email, row.id);
    return row;
  });
}

export async function update(id: number, data: Partial<NewUserRow>): Promise<UserRow | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx.update(usersTable).set(data).where(eq(usersTable.id, id)).returning();
    const row = rows[0];
    if (row && data.email !== undefined) await accountEmails.move(tx, 'staff', id, row.email);
    return row;
  });
}
