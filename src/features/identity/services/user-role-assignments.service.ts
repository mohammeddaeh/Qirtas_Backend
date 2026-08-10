import { NotFoundError, BusinessError, ForbiddenError } from '../../../core/http/api-error.js';
import * as assignmentsRepository from '../repositories/user-role-assignments.repository.js';
import * as rolesRepository from '../repositories/roles.repository.js';
import * as usersRepository from '../repositories/users.repository.js';
import * as branchesRepository from '../repositories/branches.repository.js';
import type { UserRoleAssignmentRow } from '../schemas/user-role-assignments.schema.js';
import * as auditService from './audit.service.js';
import { AUDIT, target } from './audit-actions.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import {
  toWireUserRoleAssignment,
  toWireUserRoleAssignmentWithNames,
  type WireUserRoleAssignment,
  type CreateAssignmentBody,
  type TransferAssignmentBody,
} from '../dtos/user-role-assignments.dto.js';

export async function listActiveForUser(userId: number): Promise<WireUserRoleAssignment[]> {
  // Names joined in — a client cannot render "role 3 at branch 16".
  const rows = await assignmentsRepository.findActiveForUserWithNames(userId);
  return rows.map(toWireUserRoleAssignmentWithNames);
}

/**
 * The postings this person has finished — the archive half of the same record.
 *
 * Each carries the role's name as it stood while the posting ran, which is the
 * whole reason this list is worth reading: the live join gives today's name, so
 * without the reconstruction a closed 2025 posting would claim the person held
 * a role that did not exist under that name until 2026.
 *
 * Resolved per row rather than in one pass because the rows rarely number more
 * than a handful and each needs its own instant; the index this rides on
 * (`audit_log_entries_target_created_idx`) is built for exactly this lookup.
 */
export async function listEndedForUser(userId: number): Promise<WireUserRoleAssignment[]> {
  const rows = await assignmentsRepository.findEndedForUserWithNames(userId);

  return Promise.all(
    rows.map(async (row) => {
      const wire = toWireUserRoleAssignmentWithNames(row);
      const nameThen = await auditService.resolveNameAt(
        target.role(row.role_id),
        row.valid_from,
        row.role_name,
      );
      return {
        ...wire,
        // Null, not a copy of `role_name`, when nothing was renamed: the client
        // shows the "was called X" note only when there is something to say,
        // and an equal pair would make every ended posting carry a redundant
        // aside.
        role_name_then: nameThen === row.role_name ? null : nameThen,
      };
    }),
  );
}

async function assertActorOutranksRole(actorUserId: number, roleId: number): Promise<void> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');
  if (role.level === null) return;
  const actorLevel = await assignmentsRepository.findHighestAuthorityLevel(actorUserId);
  if (actorLevel === null) return;
  if (role.level <= actorLevel) {
    throw new ForbiddenError(
      'Cannot assign a role at or above your own authority level',
      undefined,
      'role_above_actor_level',
    );
  }
}

export async function createAssignment(
  actor: RequestActorContext,
  userId: number,
  body: CreateAssignmentBody,
): Promise<WireUserRoleAssignment> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  await assertActorOutranksRole(actor.userId, body.role_id);

  // Checked here so the refusal is a translated 409 rather than the raw unique
  // -violation the partial index would otherwise raise as a 500. The index
  // stays as the real guarantee (a concurrent pair of requests can still race
  // past this check); this exists so the ordinary case reads like a rule and
  // not like a crash.
  const duplicate = await assignmentsRepository.findActiveForUser(userId);
  const branchId = body.branch_id ?? null;
  if (duplicate.some((a) => a.role_id === body.role_id && a.branch_id === branchId)) {
    throw new BusinessError(
      409,
      'This person already holds that role in that branch.',
      'assignment_duplicate',
    );
  }

  const row = await assignmentsRepository.insert({
    user_id: userId,
    role_id: body.role_id,
    branch_id: body.branch_id ?? null,
    ...(body.valid_from ? { valid_from: body.valid_from } : {}),
    valid_to: body.valid_to ?? null,
  });
  await auditService.record(actor, AUDIT.assignmentCreate, target.assignment(row.id), null, {
    user_id: row.user_id,
    role_id: row.role_id,
    branch_id: row.branch_id,
  });
  return toWireUserRoleAssignment(row);
}

/**
 * "Last qualified staff" guard — checked against active (`status=active`)
 * OTHER holders only. Applies to both transfer and offboarding, since both
 * close the current assignment the same way.
 *
 * **Scoped to structural roles** (see [GUARDED_ROLE_CATEGORIES], 2026-08-04).
 * The earlier decision (2026-07-09) applied it to every role uniformly, having
 * rejected a *functional* split ("production" vs "sales"). The split adopted
 * here is a different axis — structural: the person responsible for a branch
 * versus the staff working in it. Ordinary staff move and leave constantly and
 * nothing is lost when they do, because the assignment row is closed rather
 * than deleted; blocking that made every role introduced into a branch a
 * permanent commitment.
 *
 * Scoped to branches that are still operating. The rule exists to stop work
 * from stranding in a branch queue with nobody qualified to finish it
 * (users_roles.md §Scenarios) — a branch that is closed, temporarily or for
 * good, has no queue to strand. Applying it there would also deadlock the
 * documented closure flow (§Flow.2 and the "4 employees" success scenario):
 * closing for good requires every assignment resolved, and each branch's last
 * holder of a role could never be resolved.
 */
async function assertReplacementAvailableIfLast(assignmentId: number): Promise<void> {
  const assignment = await assignmentsRepository.findById(assignmentId);
  if (!assignment) throw new NotFoundError('Assignment not found');
  await assertAssignmentIsReplaceable(assignment);
}

/**
 * Every active assignment a user holds must be individually replaceable before
 * that user can be taken out of service.
 *
 * Exists because `disableUser`/`suspendUser` bypassed the guard entirely
 * (production_readiness.md §A2): ending one assignment was refused while
 * disabling the whole person — which ends *all* of them at once — went
 * through silently. A guard with an open door beside it is worse than no
 * guard, because it reads as protection.
 */
export async function assertUserIsReleasable(userId: number): Promise<void> {
  const assignments = await assignmentsRepository.findActiveForUser(userId);
  for (const assignment of assignments) {
    await assertAssignmentIsReplaceable(assignment);
  }
}

/**
 * Role categories whose last holder cannot be released without a replacement.
 *
 * - `management` — the branch's responsible person. A branch that operates with
 *   nobody in charge has no one to decide anything in it, which is why this is
 *   the one post that must not simply disappear (2026-08-04 decision).
 * - `system` — org-wide authority (المدير العام / مدقق). Not a branch concern
 *   at all; included so releasing the last holder cannot lock every
 *   administrator out of the system. This is a safety property, not a staffing
 *   rule, and it is why the set is a list rather than `=== 'management'`.
 *
 * Everything else — `operational`, `financial`, `external` — is deliberately
 * free: those posts can be changed, moved between branches, or ended outright,
 * because nothing is lost when they are (the assignment row is closed, never
 * deleted, so the history survives intact).
 */
const GUARDED_ROLE_CATEGORIES = new Set(['management', 'system']);

async function assertAssignmentIsReplaceable(assignment: UserRoleAssignmentRow): Promise<void> {
  // Category first: it decides whether the rule applies at all, and skipping
  // the branch/holder lookups for the common (operational) case keeps ordinary
  // staff moves at a single query.
  const role = await rolesRepository.findById(assignment.role_id);
  if (role === undefined || !GUARDED_ROLE_CATEGORIES.has(role.category)) return;

  if (assignment.branch_id !== null) {
    const branch = await branchesRepository.findById(assignment.branch_id);
    // A missing branch cannot be operating either — guard only what is active.
    if (branch?.status !== 'active') return;
  }

  const otherHolders = await assignmentsRepository.countOtherActiveHolders({
    roleId: assignment.role_id,
    branchId: assignment.branch_id,
    excludingUserId: assignment.user_id,
  });

  if (otherHolders === 0) {
    throw new BusinessError(
      409,
      'This is the last active staff member holding this role in this branch. Assign a qualified replacement before transferring or removing them.',
      // An admin reads this mid-task, so it follows req.lang; the English
      // string above stays as the fallback and for logs.
      'last_qualified_staff',
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
  actor: RequestActorContext,
  assignmentId: number,
  body: TransferAssignmentBody,
): Promise<WireUserRoleAssignment> {
  const current = await assignmentsRepository.findById(assignmentId);
  if (!current) throw new NotFoundError('Assignment not found');

  await assertReplacementAvailableIfLast(assignmentId);
  await assertActorOutranksRole(actor.userId, body.new_role_id);

  const effectiveAt = body.effective_at ?? new Date();
  await assignmentsRepository.closeAssignment(assignmentId, effectiveAt);

  const row = await assignmentsRepository.insert({
    user_id: current.user_id,
    role_id: body.new_role_id,
    branch_id: body.new_branch_id,
    valid_from: effectiveAt,
    valid_to: null,
  });

  // Keyed on the assignment that was CLOSED, not the one opened: that is the
  // record whose history a reader follows, and the new id appears in the diff.
  await auditService.record(
    actor,
    AUDIT.assignmentTransfer,
    target.assignment(assignmentId),
    { role_id: current.role_id, branch_id: current.branch_id },
    { role_id: row.role_id, branch_id: row.branch_id, new_assignment_id: row.id },
  );
  return toWireUserRoleAssignment(row);
}

/** Offboarding path: closes the assignment with no replacement opened. Same last-qualified-staff guard applies. */
export async function endAssignment(
  actor: RequestActorContext,
  assignmentId: number,
  effectiveAt: Date = new Date(),
): Promise<WireUserRoleAssignment> {
  await assertReplacementAvailableIfLast(assignmentId);
  const row = await assignmentsRepository.closeAssignment(assignmentId, effectiveAt);
  if (!row) throw new NotFoundError('Assignment not found');
  await auditService.record(
    actor,
    AUDIT.assignmentEnd,
    target.assignment(assignmentId),
    { user_id: row.user_id, role_id: row.role_id, branch_id: row.branch_id, valid_to: null },
    { valid_to: row.valid_to },
  );
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
