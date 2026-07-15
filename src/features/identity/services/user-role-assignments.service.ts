import { NotFoundError, BusinessError, ForbiddenError } from '../../../core/http/api-error.js';
import * as assignmentsRepository from '../repositories/user-role-assignments.repository.js';
import * as rolesRepository from '../repositories/roles.repository.js';
import * as usersRepository from '../repositories/users.repository.js';
import {
  toWireUserRoleAssignment,
  type WireUserRoleAssignment,
  type CreateAssignmentBody,
  type TransferAssignmentBody,
} from '../dtos/user-role-assignments.dto.js';

export async function listActiveForUser(userId: number): Promise<WireUserRoleAssignment[]> {
  const rows = await assignmentsRepository.findActiveForUser(userId);
  return rows.map(toWireUserRoleAssignment);
}

async function assertActorOutranksRole(actorUserId: number, roleId: number): Promise<void> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');
  if (role.level === null) return;
  const actorLevel = await assignmentsRepository.findHighestAuthorityLevel(actorUserId);
  if (actorLevel === null) return;
  if (role.level <= actorLevel) {
    throw new ForbiddenError('Cannot assign a role at or above your own authority level');
  }
}

export async function createAssignment(
  actorUserId: number,
  userId: number,
  body: CreateAssignmentBody,
): Promise<WireUserRoleAssignment> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  await assertActorOutranksRole(actorUserId, body.role_id);

  const row = await assignmentsRepository.insert({
    user_id: userId,
    role_id: body.role_id,
    branch_id: body.branch_id ?? null,
    ...(body.valid_from ? { valid_from: body.valid_from } : {}),
    valid_to: body.valid_to ?? null,
  });
  return toWireUserRoleAssignment(row);
}

/**
 * "Last qualified staff" guard — uniform across every role (no production/
 * sales distinction), checked against active (status=active) OTHER holders
 * only (users_roles.md, 2026-07-09). Applies to both transfer and offboarding
 * since both close the current assignment the same way.
 */
async function assertReplacementAvailableIfLast(assignmentId: number): Promise<void> {
  const assignment = await assignmentsRepository.findById(assignmentId);
  if (!assignment) throw new NotFoundError('Assignment not found');

  const otherHolders = await assignmentsRepository.countOtherActiveHolders({
    roleId: assignment.role_id,
    branchId: assignment.branch_id,
    excludingUserId: assignment.user_id,
  });

  if (otherHolders === 0) {
    throw new BusinessError(
      409,
      'This is the last active staff member holding this role in this branch. Assign a qualified replacement before transferring or removing them.',
    );
  }
}

/**
 * Branch/role transfer never mutates branch_id in place — closes the current
 * assignment (valid_to = effective date) and opens a new one, preserving
 * history. Transfers proceed immediately (in-progress tasks stay with the
 * branch queue, not the person) UNLESS this is the last qualified holder.
 */
export async function transferAssignment(
  actorUserId: number,
  assignmentId: number,
  body: TransferAssignmentBody,
): Promise<WireUserRoleAssignment> {
  const current = await assignmentsRepository.findById(assignmentId);
  if (!current) throw new NotFoundError('Assignment not found');

  await assertReplacementAvailableIfLast(assignmentId);
  await assertActorOutranksRole(actorUserId, body.new_role_id);

  const effectiveAt = body.effective_at ?? new Date();
  await assignmentsRepository.closeAssignment(assignmentId, effectiveAt);

  const row = await assignmentsRepository.insert({
    user_id: current.user_id,
    role_id: body.new_role_id,
    branch_id: body.new_branch_id,
    valid_from: effectiveAt,
    valid_to: null,
  });
  return toWireUserRoleAssignment(row);
}

/** Offboarding path: closes the assignment with no replacement opened. Same last-qualified-staff guard applies. */
export async function endAssignment(
  assignmentId: number,
  effectiveAt: Date = new Date(),
): Promise<WireUserRoleAssignment> {
  await assertReplacementAvailableIfLast(assignmentId);
  const row = await assignmentsRepository.closeAssignment(assignmentId, effectiveAt);
  if (!row) throw new NotFoundError('Assignment not found');
  return toWireUserRoleAssignment(row);
}

export async function getEffectivePermissionKeys(
  userId: number,
  branchId: number | null,
): Promise<string[]> {
  return assignmentsRepository.findEffectivePermissionKeys(userId, branchId);
}

/**
 * `findEffectivePermissionKeys(userId, branchId)` already unions branch-scoped
 * and branch-unrestricted assignments when branchId is a real id (see the
 * repository's branchClause) — passing branchId=null there deliberately
 * narrows to unrestricted-only, so it's used here just to check platform-wide
 * actions with no branch context at all.
 */
export async function hasPermission(
  userId: number,
  branchId: number | null,
  permissionKey: string,
): Promise<boolean> {
  const keys = await assignmentsRepository.findEffectivePermissionKeys(userId, branchId);
  return keys.includes(permissionKey);
}
