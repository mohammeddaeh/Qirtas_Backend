import { NotFoundError, BusinessError, ForbiddenError } from '../../../core/http/api-error.js';
import {
  paginated,
  type PaginationParams,
  type Paginated,
} from '../../../core/pagination/pagination.js';
import * as rolesRepository from '../repositories/roles.repository.js';
import * as userRoleAssignmentsRepository from '../repositories/user-role-assignments.repository.js';
import * as permissionsService from './permissions.service.js';
import * as auditService from './audit.service.js';
import type { RequestActorContext } from './audit.service.js';
import {
  toWireRole,
  type WireRole,
  type CreateRoleBody,
  type UpdateRolePermissionsBody,
} from '../dtos/roles.dto.js';
import { toWirePermission } from '../dtos/permissions.dto.js';

export const SUPER_ADMIN_ROLE_NAME = 'Super Admin';
/** Soft cap — informational only, never blocks creation (users_roles.md, 2026-07-09). */
const ROLE_SOFT_CAP = 25;

export async function listRoles(params: PaginationParams): Promise<Paginated<WireRole>> {
  const { rows, total } = await rolesRepository.findMany(params);
  return paginated(
    rows.map((r) => toWireRole(r)),
    total,
    params,
  );
}

export async function getRoleById(id: number): Promise<WireRole> {
  const row = await rolesRepository.findById(id);
  if (!row) throw new NotFoundError('Role not found');
  const permissions = await rolesRepository.findPermissionsByRole(id);
  return toWireRole(row, permissions.map(toWirePermission));
}

/**
 * Privilege-escalation guard: an actor cannot create/edit/assign a role at a
 * level equal to or higher (numerically lower-or-equal) than their own
 * highest-authority level. Actors with no active assignment (e.g. Setup
 * Wizard bootstrap) are exempt — there is nothing to escalate from yet.
 */
async function assertActorOutranks(actorUserId: number, targetLevel: number | null): Promise<void> {
  if (targetLevel === null) return; // Auditor-style roles carry no authority level to compare against.
  const actorLevel = await userRoleAssignmentsRepository.findHighestAuthorityLevel(actorUserId);
  if (actorLevel === null) return;
  if (targetLevel <= actorLevel) {
    throw new ForbiddenError('Cannot create or modify a role at or above your own authority level');
  }
}

export async function createRole(actorUserId: number, body: CreateRoleBody): Promise<WireRole> {
  const existingByName = await rolesRepository.findByName(body.name);
  if (existingByName) {
    throw new BusinessError(409, `Role name "${body.name}" is already in use`);
  }

  let permissionKeys = body.permission_keys;
  let category = body.category;
  let level: number | null = null;

  if (body.clone_from_role_id) {
    const source = await rolesRepository.findById(body.clone_from_role_id);
    if (!source) throw new NotFoundError('Source role to clone from was not found');
    const sourceKeys = await rolesRepository.findPermissionKeys(source.id);
    permissionKeys = permissionKeys.length > 0 ? permissionKeys : sourceKeys;
    category = category ?? source.category;
    level = source.level;
  }

  await assertActorOutranks(actorUserId, level);
  await permissionsService.assertPermissionKeysExist(permissionKeys);

  if (!body.force) {
    const duplicate = await rolesRepository.findActiveRoleIdWithExactPermissionSet(permissionKeys);
    if (duplicate !== undefined) {
      throw new BusinessError(
        409,
        `An active role (id ${duplicate}) already has this exact permission set. Pass force=true to create anyway.`,
      );
    }
  }

  const row = await rolesRepository.insert({
    name: body.name,
    category,
    level,
    is_system_default: false,
    is_active: true,
  });
  await rolesRepository.insertPermissions(row.id, permissionKeys);
  const permissions = await rolesRepository.findPermissionsByRole(row.id);

  return toWireRole(row, permissions.map(toWirePermission));
}

/** True once the number of active roles exceeds the informational soft cap (never blocks creation). */
export async function isOverSoftCap(): Promise<boolean> {
  const activeCount = await rolesRepository.countActive();
  return activeCount > ROLE_SOFT_CAP;
}

export async function updateRolePermissions(
  actor: RequestActorContext,
  roleId: number,
  body: UpdateRolePermissionsBody,
): Promise<WireRole> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  await assertActorOutranks(actor.userId, role.level);
  await permissionsService.assertPermissionKeysExist(body.permission_keys);

  const previousKeys = await rolesRepository.findPermissionKeys(roleId);
  await rolesRepository.replacePermissions(roleId, body.permission_keys);

  const touchesSensitive =
    (await permissionsService.isAnySensitive(previousKeys)) ||
    (await permissionsService.isAnySensitive(body.permission_keys));
  if (touchesSensitive) {
    await auditService.record(
      actor,
      'role.permissions.update',
      `role:${roleId}`,
      previousKeys,
      body.permission_keys,
    );
  }

  // Notify every currently-assigned user that their effective permissions changed (2026-07-09 decision).
  // Actual notification delivery is out of scope for this module (backlog.md #18) — this is the hook point.

  const permissions = await rolesRepository.findPermissionsByRole(roleId);
  return toWireRole(role, permissions.map(toWirePermission));
}

/**
 * Level edits require Super Admin exclusively — a hard exception, not the
 * usual relative-level comparison (see users_roles.md, "سد ثغرة"): checking
 * against the actor's own level would let a Super-Admin-level actor raise
 * their own role's level right after the check runs. This looks up the
 * actor's active role assignments directly rather than trusting a caller-
 * supplied flag.
 */
export async function updateRoleLevel(
  actorUserId: number,
  roleId: number,
  level: number,
): Promise<WireRole> {
  const isSuperAdmin = await actorHoldsSuperAdmin(actorUserId);
  if (!isSuperAdmin) {
    throw new ForbiddenError("Only Super Admin can change a role's authority level");
  }
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  const row = await rolesRepository.setLevel(roleId, level);
  if (!row) throw new NotFoundError('Role not found');
  return toWireRole(row);
}

async function actorHoldsSuperAdmin(actorUserId: number): Promise<boolean> {
  const assignments = await userRoleAssignmentsRepository.findActiveForUser(actorUserId);
  if (assignments.length === 0) return false;
  const superAdminRole = await rolesRepository.findActiveByName(SUPER_ADMIN_ROLE_NAME);
  if (!superAdminRole) return false;
  return assignments.some((a) => a.role_id === superAdminRole.id);
}

export async function deactivateRole(roleId: number): Promise<WireRole> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  if (role.name === SUPER_ADMIN_ROLE_NAME) {
    throw new ForbiddenError('The Super Admin role can never be deactivated');
  }

  const hasActive = await rolesRepository.hasActiveAssignments(roleId);
  if (hasActive) {
    throw new BusinessError(
      409,
      'This role has active user assignments. Reassign every affected user to another role first.',
    );
  }

  const row = await rolesRepository.setActive(roleId, false);
  if (!row) throw new NotFoundError('Role not found');
  return toWireRole(row);
}
