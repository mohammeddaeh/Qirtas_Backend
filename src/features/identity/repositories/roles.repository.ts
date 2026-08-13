import { eq, ne, count, and, sql, asc, desc, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import { likeTerm } from '../../../core/db/like-term.js';
import { rolesTable, type RoleRow, type NewRoleRow } from '../schemas/roles.schema.js';
import {
  rolePermissionsTable,
  type RolePermissionRow,
  type NewRolePermissionRow,
} from '../schemas/role-permissions.schema.js';
import { permissionsTable, type PermissionRow } from '../schemas/permissions.schema.js';
import { userRoleAssignmentsTable } from '../schemas/user-role-assignments.schema.js';
import { usersTable } from '../schemas/users.schema.js';
import { branchesTable } from '../schemas/branches.schema.js';
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
  // Always present: `archived` chooses which of the two catalogues you are
  // browsing, and every other filter narrows within that choice.
  conditions.push(
    filter.archived === true
      ? sql`${rolesTable.archived_at} IS NOT NULL`
      : sql`${rolesTable.archived_at} IS NULL`,
  );
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

  if (filter.search !== undefined && filter.search.length > 0) {
    // Name only — a role has no other free-text identity worth matching, and
    // `category` is already an exact filter of its own.
    conditions.push(sql`${rolesTable.name} ILIKE ${likeTerm(filter.search)}` as SQL);
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

/**
 * Whether a visitor may name this role in a self-registration request.
 *
 * Two conditions, each for its own reason:
 * - `is_active` — a retired role is refused at assignment time
 *   (`role_inactive_unassignable`), so requesting one is a guaranteed dead end.
 * - not `system` — that category is the internal provisioning group (Super
 *   Admin, auditor). Those are granted by an admin, never applied for; letting
 *   a stranger file a request for Super Admin puts a line an admin has to read
 *   and reject into a queue that is their working tool.
 *
 * The single definition behind BOTH the public catalog and the register
 * endpoint's guard — a catalog the write path does not enforce is decorative.
 */
export function isSelfRegisterable(row: RoleRow): boolean {
  // Archived is checked here rather than only in the query above, because this
  // predicate is also the register endpoint's write guard: a catalogue that
  // hides a role while the write path still accepts its id lets a crafted body
  // request the one role an admin has declared finished.
  return row.archived_at === null && row.is_active && row.category !== 'system';
}

/**
 * The self-registration catalog — every role [isSelfRegisterable] accepts.
 *
 * Unpaginated on purpose: this is a bounded catalog (the soft cap is 25 active
 * roles) read by an anonymous form that has nowhere to put a "load more".
 */
export function findSelfRegisterable(): Promise<RoleRow[]> {
  return db
    .select()
    .from(rolesTable)
    .where(
      and(
        sql`${rolesTable.archived_at} IS NULL`,
        eq(rolesTable.is_active, true),
        ne(rolesTable.category, 'system'),
      ),
    )
    .orderBy(asc(rolesTable.name));
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
    .where(and(sql`${rolesTable.archived_at} IS NULL`, eq(rolesTable.is_active, true)));
  return result[0]?.value ?? 0;
}

/** Sets or clears `archived_at`. Split from [update] so no ordinary role edit can touch it by spreading a body. */
export async function setArchivedAt(id: number, at: Date | null): Promise<RoleRow | undefined> {
  const rows = await db
    .update(rolesTable)
    .set({ archived_at: at })
    .where(eq(rolesTable.id, id))
    .returning();
  return rows[0];
}

export async function insert(data: NewRoleRow): Promise<RoleRow> {
  const rows = await db.insert(rolesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

/** Identity fields only — `level` and `is_active` have their own setters so the
 * guards protecting each cannot be bypassed through a generic update. */
export async function updateIdentity(
  id: number,
  data: Partial<Pick<RoleRow, 'name' | 'category'>>,
): Promise<RoleRow | undefined> {
  const rows = await db.update(rolesTable).set(data).where(eq(rolesTable.id, id)).returning();
  return rows[0];
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
  /**
   * The role being edited, excluded from the comparison.
   *
   * Without it, saving a role's permissions would always report a duplicate —
   * itself. Absent on create, where there is no self yet.
   */
  excludeRoleId?: number,
): Promise<number | undefined> {
  // Archived roles are excluded alongside inactive ones: the warning asks
  // "does an equivalent role already exist to use instead?", and pointing the
  // reader at a role that appears in no list is an answer they cannot act on.
  const inService = and(sql`${rolesTable.archived_at} IS NULL`, eq(rolesTable.is_active, true));
  const activeAndNotSelf =
    excludeRoleId === undefined ? inService : and(inService, ne(rolesTable.id, excludeRoleId));

  if (permissionKeys.length === 0) {
    const rows = await db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .leftJoin(rolePermissionsTable, eq(rolePermissionsTable.role_id, rolesTable.id))
      .where(activeAndNotSelf)
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
    .where(activeAndNotSelf)
    .groupBy(rolesTable.id)
    .having(sql`count(${rolePermissionsTable.id}) = ${sortedKeys.length}`);

  const match = rows.find((r) => JSON.stringify(r.keys) === JSON.stringify(sortedKeys));
  return match?.id;
}

export interface RoleHolderRow {
  assignment_id: number;
  user_id: number;
  first_name: string;
  last_name: string;
  email: string;
  user_status: string;
  branch_id: number | null;
  branch_name: string | null;
  valid_from: Date;
}

/**
 * The people actually holding this role, one row per active assignment.
 *
 * Mirrors `branchesRepository.findStaff` deliberately — same shape, same
 * pagination, same reason for keying on the ASSIGNMENT rather than the user:
 * one person may hold the same role in two branches, collapsing that to one row
 * hides the second and leaves the UI without an `assignment_id` to transfer or
 * end. The unrestricted holder (`branch_id IS NULL`) IS included here, unlike
 * on a branch roster: they genuinely hold this role, they are simply not
 * confined to a branch.
 */
export async function findHolders(
  roleId: number,
  params: PaginationParams,
): Promise<{ rows: RoleHolderRow[]; total: number }> {
  const where = and(
    eq(userRoleAssignmentsTable.role_id, roleId),
    sql`(${userRoleAssignmentsTable.valid_to} IS NULL OR ${userRoleAssignmentsTable.valid_to} > now())`,
  );

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        assignment_id: userRoleAssignmentsTable.id,
        user_id: usersTable.id,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        email: usersTable.email,
        user_status: usersTable.status,
        branch_id: branchesTable.id,
        branch_name: branchesTable.name,
        valid_from: userRoleAssignmentsTable.valid_from,
      })
      .from(userRoleAssignmentsTable)
      .innerJoin(usersTable, eq(usersTable.id, userRoleAssignmentsTable.user_id))
      // LEFT, and the clause stays in the ON: an unrestricted assignment has no
      // branch, and moving this to WHERE would collapse it to an inner join and
      // silently drop exactly those holders.
      .leftJoin(branchesTable, eq(branchesTable.id, userRoleAssignmentsTable.branch_id))
      .where(where)
      .orderBy(desc(userRoleAssignmentsTable.valid_from), desc(userRoleAssignmentsTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db
      .select({ value: count() })
      .from(userRoleAssignmentsTable)
      .innerJoin(usersTable, eq(usersTable.id, userRoleAssignmentsTable.user_id))
      .where(where),
  ]);

  return { rows, total: totalRows[0]?.value ?? 0 };
}

/**
 * Assignment rows referencing this role — **active and historical alike**.
 *
 * The gate on hard deletion. `user_role_assignments.role_id` is `ON DELETE
 * RESTRICT`, so the database already refuses; this exists so the refusal
 * arrives as a translated sentence naming the reason instead of a raw
 * constraint error.
 *
 * Counting ended assignments too is the whole point: "nobody holds it now" and
 * "nobody ever held it" are different facts, and only the second makes deletion
 * safe. Deleting a role that appears in someone's history would erase what that
 * person once was — in a project whose rule is that history is kept.
 */
export async function countAllAssignmentsEver(roleId: number): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(userRoleAssignmentsTable)
    .where(eq(userRoleAssignmentsTable.role_id, roleId));
  return rows[0]?.value ?? 0;
}

export async function deleteById(roleId: number): Promise<void> {
  // `role_permissions` cascades; assignments are RESTRICT and were checked by
  // the service before we got here.
  await db.delete(rolesTable).where(eq(rolesTable.id, roleId));
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
