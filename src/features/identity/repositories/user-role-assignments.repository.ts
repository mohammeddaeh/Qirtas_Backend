import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findOneById } from '../../../core/db/crud-helpers.js';
import {
  userRoleAssignmentsTable,
  type UserRoleAssignmentRow,
  type NewUserRoleAssignmentRow,
} from '../schemas/user-role-assignments.schema.js';
import { usersTable } from '../schemas/users.schema.js';
import { rolesTable } from '../schemas/roles.schema.js';
import { branchesTable } from '../schemas/branches.schema.js';
import { permissionsTable } from '../schemas/permissions.schema.js';
import { rolePermissionsTable } from '../schemas/role-permissions.schema.js';

const isActiveClause = sql`(${userRoleAssignmentsTable.valid_to} IS NULL OR ${userRoleAssignmentsTable.valid_to} > now())`;

export async function findActiveForUser(userId: number): Promise<UserRoleAssignmentRow[]> {
  return db
    .select()
    .from(userRoleAssignmentsTable)
    .where(and(eq(userRoleAssignmentsTable.user_id, userId), isActiveClause));
}

/** An assignment row plus the display names of what it points at. */
export interface AssignmentWithNamesRow {
  id: number;
  user_id: number;
  role_id: number;
  role_name: string;
  branch_id: number | null;
  branch_name: string | null;
  branch_status: 'active' | 'temporarily_closed' | 'closed' | null;
  valid_from: Date;
  valid_to: Date | null;
  created_at: Date;
}

/**
 * Same rows as [findActiveForUser], joined to the role and branch names.
 *
 * Raw ids are unreadable in a UI — "role 3 at branch 16" tells a human nothing
 * — and resolving them client-side would mean fetching both catalogs just to
 * label a handful of rows. `leftJoin` on branches because `branch_id` is
 * nullable: an unrestricted assignment covers every branch and must still be
 * returned, with a null name the client renders as "all branches".
 */
export async function findActiveForUserWithNames(
  userId: number,
): Promise<AssignmentWithNamesRow[]> {
  return selectAssignmentsWithNames()
    .where(and(eq(userRoleAssignmentsTable.user_id, userId), isActiveClause))
    .orderBy(userRoleAssignmentsTable.valid_from);
}

/**
 * The postings this person no longer holds — the closed half of the record.
 *
 * Nothing is deleted here: ending an assignment stamps `valid_to` and the row
 * stays. Until now only the open half was ever queried, so a person's past
 * postings existed in the database and nowhere a human could see them, which
 * makes "was they ever a cashier?" unanswerable from the app.
 */
export async function findEndedForUserWithNames(
  userId: number,
): Promise<AssignmentWithNamesRow[]> {
  return selectAssignmentsWithNames()
    .where(
      and(
        eq(userRoleAssignmentsTable.user_id, userId),
        sql`${userRoleAssignmentsTable.valid_to} IS NOT NULL AND ${userRoleAssignmentsTable.valid_to} <= now()`,
      ),
    )
    .orderBy(desc(userRoleAssignmentsTable.valid_to));
}

function selectAssignmentsWithNames() {
  return db
    .select({
      id: userRoleAssignmentsTable.id,
      user_id: userRoleAssignmentsTable.user_id,
      role_id: userRoleAssignmentsTable.role_id,
      role_name: rolesTable.name,
      branch_id: userRoleAssignmentsTable.branch_id,
      branch_name: branchesTable.name,
      // Same leftJoin that supplies the name, so no extra cost: an assignment
      // reads as active employment unless the branch's own state travels with
      // it (see the dto for why this is not optional).
      branch_status: branchesTable.status,
      valid_from: userRoleAssignmentsTable.valid_from,
      valid_to: userRoleAssignmentsTable.valid_to,
      created_at: userRoleAssignmentsTable.created_at,
    })
    .from(userRoleAssignmentsTable)
    .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
    .leftJoin(branchesTable, eq(branchesTable.id, userRoleAssignmentsTable.branch_id))
    .$dynamic();
}

export function findById(id: number): Promise<UserRoleAssignmentRow | undefined> {
  return findOneById<UserRoleAssignmentRow>(
    userRoleAssignmentsTable,
    userRoleAssignmentsTable.id,
    id,
  );
}

export async function insert(data: NewUserRoleAssignmentRow): Promise<UserRoleAssignmentRow> {
  const rows = await db.insert(userRoleAssignmentsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function closeAssignment(
  id: number,
  validTo: Date,
): Promise<UserRoleAssignmentRow | undefined> {
  const rows = await db
    .update(userRoleAssignmentsTable)
    .set({ valid_to: validTo })
    .where(eq(userRoleAssignmentsTable.id, id))
    .returning();
  return rows[0];
}

/**
 * Active assignments still pointing at a branch — the gate on the terminal
 * `closed` status (users_roles.md §Flow.2: the admin must resolve every
 * assignment, by transfer or by ending it, before a branch closes for good).
 */
export async function countActiveForBranch(branchId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(userRoleAssignmentsTable)
    .where(and(eq(userRoleAssignmentsTable.branch_id, branchId), isActiveClause));
  return Number(rows[0]?.value ?? 0);
}

// ─── Retirement counts ───────────────────────────────────────────────────────
//
// What deleting or archiving a branch / role / user would run into. Each pair
// answers the same two questions about a different owner column, and the
// difference between them is the whole distinction the feature rests on:
//
//   …Ever  — has ANYTHING ever pointed here? Zero means the row is genuinely
//            unused and can be deleted outright, because nothing is lost.
//   …Open  — is anything pointing here RIGHT NOW? Zero means it can be
//            archived: closed rows stay, and they keep resolving to a real
//            branch/role/person, so nobody's history develops a hole.
//
// These count assignment ROWS and ignore user status on purpose, unlike
// `countActiveHoldersOfRole` below. A suspended employee still occupies the
// post; retiring the branch or role under them would leave an open assignment
// pointing at something the app no longer shows anywhere.

export async function countAssignmentsEverForBranch(branchId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(userRoleAssignmentsTable)
    .where(eq(userRoleAssignmentsTable.branch_id, branchId));
  return Number(rows[0]?.value ?? 0);
}

export async function countAssignmentsEverForUser(userId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(userRoleAssignmentsTable)
    .where(eq(userRoleAssignmentsTable.user_id, userId));
  return Number(rows[0]?.value ?? 0);
}

export async function countOpenForUser(userId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(userRoleAssignmentsTable)
    .where(and(eq(userRoleAssignmentsTable.user_id, userId), isActiveClause));
  return Number(rows[0]?.value ?? 0);
}

export async function countOpenForRole(roleId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(userRoleAssignmentsTable)
    .where(and(eq(userRoleAssignmentsTable.role_id, roleId), isActiveClause));
  return Number(rows[0]?.value ?? 0);
}

/**
 * How many **distinct active people** currently hold this role, anywhere.
 *
 * Editing a role's permissions is retroactive: every one of them gains or loses
 * the ability the moment it is saved. That blast radius was invisible in the
 * app — the editor asked "which permissions?" and never said how many people
 * the answer would reach.
 *
 * Distinct users, not assignment rows: one person holding the same role in
 * three branches is one person whose abilities change, and counting three would
 * overstate the consequence. Suspended and disabled accounts are excluded —
 * they cannot act, so widening a role does not widen anything for them today.
 */
export async function countActiveHoldersOfRole(roleId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(distinct ${userRoleAssignmentsTable.user_id})` })
    .from(userRoleAssignmentsTable)
    .innerJoin(usersTable, eq(usersTable.id, userRoleAssignmentsTable.user_id))
    .where(
      and(
        eq(userRoleAssignmentsTable.role_id, roleId),
        isActiveClause,
        eq(usersTable.status, 'active'),
      ),
    );
  return Number(rows[0]?.value ?? 0);
}

/**
 * "Last qualified staff" check (uniform across every role, no production/sales
 * distinction — see users_roles.md, 2026-07-09): counts OTHER active-user,
 * active-assignment holders of the same role in the same branch, excluding
 * the given assignment/user.
 */
export async function countOtherActiveHolders(params: {
  roleId: number;
  branchId: number | null;
  excludingUserId: number;
}): Promise<number> {
  const branchClause =
    params.branchId === null
      ? sql`${userRoleAssignmentsTable.branch_id} IS NULL`
      : eq(userRoleAssignmentsTable.branch_id, params.branchId);

  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(userRoleAssignmentsTable)
    .innerJoin(usersTable, eq(usersTable.id, userRoleAssignmentsTable.user_id))
    .where(
      and(
        eq(userRoleAssignmentsTable.role_id, params.roleId),
        branchClause,
        isActiveClause,
        eq(usersTable.status, 'active'),
        sql`${userRoleAssignmentsTable.user_id} != ${params.excludingUserId}`,
      ),
    );
  return Number(rows[0]?.value ?? 0);
}

/**
 * Active posts for a whole page of users at once, keyed by user id.
 *
 * **One query for the page, not one per row.** The obvious shape — loop the
 * page and call `findActiveForUserWithNames` — is a 50-query N+1 hidden behind
 * a `Promise.all`, which looks fast locally and falls over on a real dataset.
 *
 * Returns a Map so the caller can render `[]` for a user with no posts without
 * having to tell "no posts" apart from "not in the result set".
 */
export async function findActivePostsForUsers(
  userIds: number[],
): Promise<Map<number, { role_id: number; role_name: string; branch_id: number | null; branch_name: string | null }[]>> {
  const byUser = new Map<
    number,
    { role_id: number; role_name: string; branch_id: number | null; branch_name: string | null }[]
  >();
  for (const id of userIds) byUser.set(id, []);
  if (userIds.length === 0) return byUser;

  const rows = await db
    .select({
      user_id: userRoleAssignmentsTable.user_id,
      role_id: userRoleAssignmentsTable.role_id,
      role_name: rolesTable.name,
      branch_id: userRoleAssignmentsTable.branch_id,
      branch_name: branchesTable.name,
    })
    .from(userRoleAssignmentsTable)
    .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
    .leftJoin(branchesTable, eq(branchesTable.id, userRoleAssignmentsTable.branch_id))
    .where(
      and(inArray(userRoleAssignmentsTable.user_id, userIds), isActiveClause),
    )
    .orderBy(userRoleAssignmentsTable.valid_from);

  for (const row of rows) {
    byUser.get(row.user_id)?.push({
      role_id: row.role_id,
      role_name: row.role_name,
      branch_id: row.branch_id,
      branch_name: row.branch_name,
    });
  }
  return byUser;
}

/**
 * How many **other** active people can still exercise [permissionKey] anywhere.
 *
 * The lockout check, and deliberately phrased as a permission rather than a
 * role or a category: `system` covered مدقق too, whose departure locks nobody
 * out of anything, while a custom role carrying `users.manage` was not covered
 * at all. What actually cannot be allowed to reach zero is the ability to hand
 * the ability back.
 *
 * Distinct users, and only `active` ones — a suspended account cannot
 * administer anything, so counting it would let the last real administrator
 * leave behind a door nobody can open.
 */
export async function countOtherActiveUsersWithPermission(params: {
  permissionKey: string;
  excludingUserId: number;
}): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(distinct ${userRoleAssignmentsTable.user_id})` })
    .from(userRoleAssignmentsTable)
    .innerJoin(usersTable, eq(usersTable.id, userRoleAssignmentsTable.user_id))
    .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
    .innerJoin(rolePermissionsTable, eq(rolePermissionsTable.role_id, rolesTable.id))
    // Same joins as findEffectivePermissionKeys, so this counts exactly the
    // people `requirePermission` would let through — a counter that disagreed
    // with the gate it protects would guard the wrong number.
    .innerJoin(permissionsTable, eq(permissionsTable.key, rolePermissionsTable.permission_key))
    .where(
      and(
        eq(rolePermissionsTable.permission_key, params.permissionKey),
        eq(rolesTable.is_active, true),
        isActiveClause,
        eq(usersTable.status, 'active'),
        sql`${userRoleAssignmentsTable.user_id} != ${params.excludingUserId}`,
      ),
    );
  return Number(rows[0]?.value ?? 0);
}

/**
 * Union of permission keys across every active assignment for a user,
 * restricted to a given branch or branch-unrestricted assignments (Allow-only
 * semantics — see users_roles.md). Pass branchId=null to check
 * branch-unrestricted permissions only (e.g. platform-wide actions).
 */
export async function findEffectivePermissionKeys(
  userId: number,
  branchId: number | null,
): Promise<string[]> {
  const branchClause =
    branchId === null
      ? sql`${userRoleAssignmentsTable.branch_id} IS NULL`
      : sql`(${userRoleAssignmentsTable.branch_id} IS NULL OR ${userRoleAssignmentsTable.branch_id} = ${branchId})`;

  const rows = await db
    .selectDistinct({ key: rolePermissionsTable.permission_key })
    .from(userRoleAssignmentsTable)
    .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
    .innerJoin(rolePermissionsTable, eq(rolePermissionsTable.role_id, rolesTable.id))
    .innerJoin(permissionsTable, eq(permissionsTable.key, rolePermissionsTable.permission_key))
    .where(
      and(
        eq(userRoleAssignmentsTable.user_id, userId),
        isActiveClause,
        eq(rolesTable.is_active, true),
        branchClause,
      ),
    );

  return rows.map((r) => r.key);
}

/**
 * Union of permission keys across ALL of a user's active assignments,
 * regardless of branch — used for branch-agnostic checks (identity/admin
 * endpoints like roles/branches/ownerships management, which aren't
 * themselves scoped to a single branch). For branch-scoped business actions,
 * use findEffectivePermissionKeys(userId, branchId) instead.
 */
export async function findAllEffectivePermissionKeys(userId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ key: rolePermissionsTable.permission_key })
    .from(userRoleAssignmentsTable)
    .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
    .innerJoin(rolePermissionsTable, eq(rolePermissionsTable.role_id, rolesTable.id))
    .innerJoin(permissionsTable, eq(permissionsTable.key, rolePermissionsTable.permission_key))
    .where(and(eq(userRoleAssignmentsTable.user_id, userId), isActiveClause, eq(rolesTable.is_active, true)));

  return rows.map((r) => r.key);
}

/** Lowest (= highest authority) level among a user's currently active role assignments. */
export async function findHighestAuthorityLevel(userId: number): Promise<number | null> {
  const rows = await db
    .select({ level: rolesTable.level })
    .from(userRoleAssignmentsTable)
    .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
    .where(
      and(
        eq(userRoleAssignmentsTable.user_id, userId),
        isActiveClause,
        eq(rolesTable.is_active, true),
      ),
    );

  const levels = rows.map((r) => r.level).filter((l): l is number => l !== null);
  if (levels.length === 0) return null;
  return Math.min(...levels);
}
