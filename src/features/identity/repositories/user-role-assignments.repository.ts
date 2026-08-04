import { eq, and, sql } from 'drizzle-orm';
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
  return db
    .select({
      id: userRoleAssignmentsTable.id,
      user_id: userRoleAssignmentsTable.user_id,
      role_id: userRoleAssignmentsTable.role_id,
      role_name: rolesTable.name,
      branch_id: userRoleAssignmentsTable.branch_id,
      branch_name: branchesTable.name,
      valid_from: userRoleAssignmentsTable.valid_from,
      valid_to: userRoleAssignmentsTable.valid_to,
      created_at: userRoleAssignmentsTable.created_at,
    })
    .from(userRoleAssignmentsTable)
    .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
    .leftJoin(branchesTable, eq(branchesTable.id, userRoleAssignmentsTable.branch_id))
    .where(and(eq(userRoleAssignmentsTable.user_id, userId), isActiveClause))
    .orderBy(userRoleAssignmentsTable.valid_from);
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
