import { NotFoundError, BusinessError } from '../../../core/http/api-error.js';
import {
  paginated,
  type PaginationParams,
  type Paginated,
} from '../../../core/pagination/pagination.js';
import * as branchesRepository from '../repositories/branches.repository.js';
import * as assignmentsRepository from '../repositories/user-role-assignments.repository.js';
import * as auditService from './audit.service.js';
import { AUDIT, target } from './audit-actions.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import {
  toWireBranch,
  toWireBranchStaffMember,
  type WireBranch,
  type WireBranchStaffMember,
  type CreateBranchBody,
  type UpdateBranchBody,
  type BranchesFilterQuery,
} from '../dtos/branches.dto.js';

export async function listBranches(
  params: PaginationParams,
  filter: BranchesFilterQuery,
): Promise<Paginated<WireBranch>> {
  const { rows, total } = await branchesRepository.findMany(params, filter);
  return paginated(rows.map(toWireBranch), total, params);
}

export async function getBranchById(id: number): Promise<WireBranch> {
  const row = await branchesRepository.findById(id);
  if (!row) throw new NotFoundError('Branch not found');
  return toWireBranch(row);
}

/**
 * 404s on an unknown branch rather than returning an empty page — "this branch
 * has nobody" and "this branch does not exist" are different answers, and a
 * screen that shows the first for the second invites staffing a ghost.
 */
export async function listBranchStaff(
  id: number,
  params: PaginationParams,
): Promise<Paginated<WireBranchStaffMember>> {
  const branch = await branchesRepository.findById(id);
  if (!branch) throw new NotFoundError('Branch not found');

  const { rows, total } = await branchesRepository.findStaff(id, params);
  return paginated(rows.map(toWireBranchStaffMember), total, params);
}

export async function createBranch(
  actor: RequestActorContext,
  body: CreateBranchBody,
): Promise<WireBranch> {
  const row = await branchesRepository.insert({
    name: body.name,
    address: body.address,
    contact_info: body.contact_info,
  });
  await auditService.record(actor, AUDIT.branchCreate, target.branch(row.id), null, {
    name: row.name,
    status: row.status,
  });
  return toWireBranch(row);
}

/**
 * The terminal `closed` status is the one branch transition with a
 * precondition: users_roles.md §Flow.2 requires the admin to have resolved
 * every `UserRoleAssignment` on the branch — transferred or ended — before it
 * closes for good, so nobody is left holding authority over a branch that no
 * longer exists operationally. `temporarily_closed` carries no such condition
 * (§Flow.1: a pause leaves assignments untouched and they resume on reopen).
 */
async function assertBranchIsEmptyBeforeClosing(id: number): Promise<void> {
  const remaining = await assignmentsRepository.countActiveForBranch(id);
  if (remaining > 0) {
    throw new BusinessError(
      409,
      'This branch still has active role assignments. Transfer or end them before closing it permanently.',
      'branch_has_active_assignments',
    );
  }
}

export async function updateBranch(
  actor: RequestActorContext,
  id: number,
  body: UpdateBranchBody,
): Promise<WireBranch> {
  const existing = await branchesRepository.findById(id);
  if (!existing) throw new NotFoundError('Branch not found');

  if (body.status === 'closed' && existing.status !== 'closed') {
    await assertBranchIsEmptyBeforeClosing(id);
  }

  const row = await branchesRepository.update(id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.address !== undefined ? { address: body.address } : {}),
    ...(body.contact_info !== undefined ? { contact_info: body.contact_info } : {}),
    // Stamped only on a real transition — re-saving the same status must not
    // reset the clock, or a branch could stay "recently paused" forever by
    // being edited.
    ...(body.status !== undefined && body.status !== existing.status
      ? { status: body.status, status_changed_at: new Date() }
      : {}),
  });
  if (!row) throw new NotFoundError('Branch not found');

  // Status travels in the diff even when unchanged: "who closed this branch"
  // is the question this log exists to answer, and a before/after pair is
  // readable without knowing which fields the request happened to carry.
  await auditService.record(
    actor,
    AUDIT.branchUpdate,
    target.branch(id),
    {
      name: existing.name,
      address: existing.address,
      contact_info: existing.contact_info,
      status: existing.status,
    },
    { name: row.name, address: row.address, contact_info: row.contact_info, status: row.status },
  );
  return toWireBranch(row);
}
