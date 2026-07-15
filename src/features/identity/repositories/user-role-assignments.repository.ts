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
import { permissionsTable } from '../schemas/permissions.schema.js';
import { rolePermissionsTable } from '../schemas/role-permissions.schema.js';

const isActiveClause = sql`(${userRoleAssignmentsTable.valid_to} IS NULL OR ${userRoleAssignmentsTable.valid_to} > now())`;

export async function findActiveForUser(userId: number): Promise<UserRoleAssignmentRow[]> {
  return db
    .select()
    .from(userRoleAssignmentsTable)
    .where(and(eq(userRoleAssignmentsTable.user_id, userId), isActiveClause));
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
