import { eq, count, and, sql, asc, desc, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import { rolesTable, type RoleRow, type NewRoleRow } from '../schemas/roles.schema.js';
import {
  rolePermissionsTable,
  type RolePermissionRow,
  type NewRolePermissionRow,
} from '../schemas/role-permissions.schema.js';
import { permissionsTable, type PermissionRow } from '../schemas/permissions.schema.js';
import { userRoleAssignmentsTable } from '../schemas/user-role-assignments.schema.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import type { RolesFilterQuery } from '../dtos/roles.dto.js';

const sortColumns = {
  created_at: rolesTable.created_at,
  name: rolesTable.name,
  level: rolesTable.level,
} as const;

export function findMany(
  params: PaginationParams,
  filter: RolesFilterQuery,
  /**
   * The caller's highest authority level, resolved by the service. `null` means
   * they hold no levelled assignment at all, which the guard treats as exempt —
   * so `assignable` then filters nothing.
   */
  actorLevel?: number | null,
): Promise<{ rows: RoleRow[]; total: number }> {
  const conditions: SQL[] = [];
  if (filter.category !== undefined) conditions.push(eq(rolesTable.category, filter.category));
  if (filter.is_active !== undefined) conditions.push(eq(rolesTable.is_active, filter.is_active));
  if (filter.assignable === true && actorLevel !== null && actorLevel !== undefined) {
    // Mirrors assertActorOutranksRole exactly: a role is assignable when it
    // carries no level, or sits strictly BELOW the actor's (lower = higher
    // authority, so "below" means a greater number).
    conditions.push(
      sql`(${rolesTable.level} IS NULL OR ${rolesTable.level} > ${actorLevel})` as SQL,
    );
  }

  const orderFn = filter.sort_dir === 'asc' ? asc : desc;

  return findManyPaginated<RoleRow>(rolesTable, params, {
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: orderFn(sortColumns[filter.sort_by]),
  });
}

export function findById(id: number): Promise<RoleRow | undefined> {
  return findOneById<RoleRow>(rolesTable, rolesTable.id, id);
}

export async function findByName(name: string): Promise<RoleRow | undefined> {
  const rows = await db.select().from(rolesTable).where(eq(rolesTable.name, name)).limit(1);
  return rows[0];
}

export async function findActiveByName(name: string): Promise<RoleRow | undefined> {
  const rows = await db
    .select()
    .from(rolesTable)
    .where(and(eq(rolesTable.name, name), eq(rolesTable.is_active, true)))
    .limit(1);
  return rows[0];
}

export async function countActive(): Promise<number> {
  const result = await db
    .select({ value: count() })
    .from(rolesTable)
    .where(eq(rolesTable.is_active, true));
  return result[0]?.value ?? 0;
}

export async function insert(data: NewRoleRow): Promise<RoleRow> {
  const rows = await db.insert(rolesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function setActive(id: number, isActive: boolean): Promise<RoleRow | undefined> {
  const rows = await db
    .update(rolesTable)
    .set({ is_active: isActive })
    .where(eq(rolesTable.id, id))
    .returning();
  return rows[0];
}

export async function setLevel(id: number, level: number): Promise<RoleRow | undefined> {
  const rows = await db.update(rolesTable).set({ level }).where(eq(rolesTable.id, id)).returning();
  return rows[0];
}

export async function findPermissionKeys(roleId: number): Promise<string[]> {
  const rows = await db
    .select({ permission_key: rolePermissionsTable.permission_key })
    .from(rolePermissionsTable)
    .where(eq(rolePermissionsTable.role_id, roleId));
  return rows.map((r) => r.permission_key);
}

export async function findPermissionsByRole(roleId: number): Promise<PermissionRow[]> {
  const rows = await db
    .select({ permission: permissionsTable })
    .from(rolePermissionsTable)
    .innerJoin(permissionsTable, eq(permissionsTable.key, rolePermissionsTable.permission_key))
    .where(eq(rolePermissionsTable.role_id, roleId));
  return rows.map((r) => r.permission);
}

/** Exact-match lookup used by the role-explosion-prevention warning (same permission set as an existing active role). */
export async function findActiveRoleIdWithExactPermissionSet(
  permissionKeys: string[],
): Promise<number | undefined> {
  if (permissionKeys.length === 0) {
    const rows = await db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .leftJoin(rolePermissionsTable, eq(rolePermissionsTable.role_id, rolesTable.id))
      .where(eq(rolesTable.is_active, true))
      .groupBy(rolesTable.id)
      .having(sql`count(${rolePermissionsTable.id}) = 0`)
      .limit(1);
    return rows[0]?.id;
  }

  const sortedKeys = [...permissionKeys].sort();
  const rows = await db
    .select({
      id: rolesTable.id,
      keys: sql<
        string[]
      >`array_agg(${rolePermissionsTable.permission_key} ORDER BY ${rolePermissionsTable.permission_key})`,
    })
    .from(rolesTable)
    .innerJoin(rolePermissionsTable, eq(rolePermissionsTable.role_id, rolesTable.id))
    .where(eq(rolesTable.is_active, true))
    .groupBy(rolesTable.id)
    .having(sql`count(${rolePermissionsTable.id}) = ${sortedKeys.length}`);

  const match = rows.find((r) => JSON.stringify(r.keys) === JSON.stringify(sortedKeys));
  return match?.id;
}

export async function replacePermissions(roleId: number, permissionKeys: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(rolePermissionsTable).where(eq(rolePermissionsTable.role_id, roleId));
    if (permissionKeys.length > 0) {
      const values: NewRolePermissionRow[] = permissionKeys.map((permission_key) => ({
        role_id: roleId,
        permission_key,
      }));
      await tx.insert(rolePermissionsTable).values(values);
    }
  });
}

export async function insertPermissions(
  roleId: number,
  permissionKeys: string[],
): Promise<RolePermissionRow[]> {
  if (permissionKeys.length === 0) return [];
  const values: NewRolePermissionRow[] = permissionKeys.map((permission_key) => ({
    role_id: roleId,
    permission_key,
  }));
  return db.insert(rolePermissionsTable).values(values).returning();
}

/** Any active (non-expired) assignment referencing this role — used by the deactivation guard. */
export async function hasActiveAssignments(roleId: number): Promise<boolean> {
  const rows = await db
    .select({ value: count() })
    .from(userRoleAssignmentsTable)
    .where(
      and(
        eq(userRoleAssignmentsTable.role_id, roleId),
        sql`(${userRoleAssignmentsTable.valid_to} IS NULL OR ${userRoleAssignmentsTable.valid_to} > now())`,
      ),
    );
  return (rows[0]?.value ?? 0) > 0;
}
