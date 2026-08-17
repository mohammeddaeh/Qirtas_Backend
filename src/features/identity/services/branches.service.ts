import { NotFoundError, BusinessError, ForbiddenError } from '../../../core/http/api-error.js';
import {
  paginated,
  type PaginationParams,
  type Paginated,
} from '../../../core/pagination/pagination.js';
import * as branchesRepository from '../repositories/branches.repository.js';
import * as assignmentsRepository from '../repositories/user-role-assignments.repository.js';
import * as ownershipsRepository from '../repositories/ownerships.repository.js';
import * as auditService from './audit.service.js';
import { AUDIT, target } from './audit-actions.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import type { BranchRow } from '../schemas/branches.schema.js';
import {
  toWireBranch,
  toWireBranchStaffMember,
  type WireBranch,
  type WireBranchStaffMember,
  type BranchRetirementFacts,
  type CreateBranchBody,
  type UpdateBranchBody,
  type BranchesFilterQuery,
} from '../dtos/branches.dto.js';

export async function listBranches(
  params: PaginationParams,
  filter: BranchesFilterQuery,
): Promise<Paginated<WireBranch>> {
  const { rows, total } = await branchesRepository.findMany(params, filter);
  // Arrow, not a bare reference: `map` would pass the index as the facts
  // argument, and the counts are a per-row aggregate the list deliberately
  // does not run.
  return paginated(
    rows.map((row) => toWireBranch(row)),
    total,
    params,
  );
}

/**
 * The branch catalog a self-registering visitor picks from — the ONLY branches
 * endpoint reachable without a session.
 *
 * Registration needs this list and has no session to read `GET /branches` with
 * (that one is `requireAuth`): the form is filled in before an account exists.
 * Without it the branch field on the register screen answers 401 and sits
 * permanently empty — the same hole the roles picker had, which is why
 * `GET /roles/self-registerable` exists one field above.
 *
 * Sends the same `WireBranch` shape as every other branches endpoint rather
 * than a trimmed one — one wire shape, one client model, one picker. The
 * per-row aggregates stay off it exactly as they do on `GET /branches`, so
 * nothing about who staffs a branch leaks to an anonymous caller.
 */
export async function listSelfRegisterableBranches(): Promise<WireBranch[]> {
  const rows = await branchesRepository.findSelfRegisterable();
  return rows.map((row) => toWireBranch(row));
}

export async function getBranchById(id: number): Promise<WireBranch> {
  const row = await branchesRepository.findById(id);
  if (!row) throw new NotFoundError('Branch not found');
  return toWireBranch(row, await retirementFacts(row));
}

/**
 * The two questions the detail screen has to answer before offering to remove a
 * branch, computed by exactly the rules [deleteBranch] and [archiveBranch]
 * enforce.
 *
 * Same rules, one place: a client that offered delete on its own guess would
 * put a button in front of the user that always fails, and one that hid the
 * button whenever it was unsure would make three different situations look
 * identical — the mistake `role_detail_screen.dart` was written to undo.
 *
 * The counts travel with the verdicts so the refusal can be a sentence. "This
 * branch cannot be deleted" is not information; "7 assignments have referenced
 * it — archive it instead" is.
 */
async function retirementFacts(row: BranchRow): Promise<BranchRetirementFacts> {
  const [openAssignments, assignmentsEver, openOwnerships, ownershipsEver] = await Promise.all([
    assignmentsRepository.countActiveForBranch(row.id),
    assignmentsRepository.countAssignmentsEverForBranch(row.id),
    ownershipsRepository.countOpenForBranch(row.id),
    ownershipsRepository.countEverForBranch(row.id),
  ]);

  return {
    is_deletable: !row.is_default && assignmentsEver === 0 && ownershipsEver === 0,
    // An already-archived branch is not archivable again — the client shows
    // "restore", not a second archive button.
    is_archivable:
      !row.is_default &&
      row.archived_at === null &&
      openAssignments === 0 &&
      openOwnerships === 0,
    open_assignments_count: openAssignments,
    assignments_ever_count: assignmentsEver,
    open_ownerships_count: openOwnerships,
    ownerships_ever_count: ownershipsEver,
  };
}

/**
 * The default branch is exempt from both exits.
 *
 * Not a policy choice about tidiness: `is_default` is what the system falls
 * back to when something needs a branch and none was named, so removing it —
 * destroyed or merely hidden — breaks that fallback with no error at the moment
 * of the decision, only later, somewhere else.
 */
function assertNotDefault(row: BranchRow): void {
  if (!row.is_default) return;
  throw new ForbiddenError(
    'The default branch cannot be removed — make another branch the default first',
    undefined,
    'branch_is_default',
  );
}

/**
 * Destroys a branch nothing has ever pointed at.
 *
 * This is the easy half, and it exists because the hard half kept being applied
 * to it: a branch added by mistake five minutes ago has no history to protect,
 * and had no way out of the list at all before this endpoint — the best
 * available was "permanently closed", which leaves the row in every picker
 * forever wearing a status that says something untrue about the organisation.
 *
 * The bar is "nobody was EVER here", not "nobody is here now". The second is
 * what [archiveBranch] is for, and confusing them is what would erase history:
 * both branches show an empty staff list, and only one of them is empty.
 */
export async function deleteBranch(actor: RequestActorContext, id: number): Promise<void> {
  const branch = await branchesRepository.findById(id);
  if (!branch) throw new NotFoundError('Branch not found');

  assertNotDefault(branch);

  const [assignmentsEver, ownershipsEver] = await Promise.all([
    assignmentsRepository.countAssignmentsEverForBranch(id),
    ownershipsRepository.countEverForBranch(id),
  ]);

  if (assignmentsEver > 0 || ownershipsEver > 0) {
    throw new BusinessError(
      409,
      `This branch has ${assignmentsEver} assignment(s) and ${ownershipsEver} ownership record(s) in its history. Archive it instead — deleting would erase where those people worked.`,
      'branch_has_history',
    );
  }

  // Recorded BEFORE the delete: afterwards there is no row to describe, and
  // naming what disappeared is the entry's whole value.
  await auditService.record(
    actor,
    AUDIT.branchDelete,
    target.branch(id),
    { name: branch.name, address: branch.address, status: branch.status },
    null,
  );

  await branchesRepository.deleteById(id);
}

/**
 * Retires a branch that HAS a past — hidden everywhere, destroyed nowhere.
 *
 * The answer to the case deletion cannot serve: a branch people worked in for
 * two years, empty since. `user_role_assignments.branch_id` is `RESTRICT`, and
 * those closed rows are where "أحمد worked here in 2024" is written, so the row
 * must survive for the history to keep resolving to a real name. What the admin
 * actually wanted was for it to stop appearing, and that is what this does.
 *
 * Status is forced to `closed` in the same write rather than left as it was.
 * The precondition just verified — no open assignment, no open ownership — IS
 * the condition `closed` documents (users_roles.md §Flow.2), so any other value
 * would be a leftover claim about an organisation that has moved on, and the
 * branch would come back from the archive still calling itself active.
 */
export async function archiveBranch(
  actor: RequestActorContext,
  id: number,
): Promise<WireBranch> {
  const branch = await branchesRepository.findById(id);
  if (!branch) throw new NotFoundError('Branch not found');

  // Idempotent rather than a 409: two admins reaching the same conclusion is
  // not a conflict, and the caller's intent already holds.
  if (branch.archived_at !== null) return toWireBranch(branch, await retirementFacts(branch));

  assertNotDefault(branch);

  await assertBranchIsEmptyBeforeClosing(id);

  const openOwnerships = await ownershipsRepository.countOpenForBranch(id);
  if (openOwnerships > 0) {
    throw new BusinessError(
      409,
      `This branch still has ${openOwnerships} active ownership record(s). End them before archiving it.`,
      'branch_has_active_ownerships',
    );
  }

  const archivedAt = new Date();
  const row = await branchesRepository.update(id, {
    archived_at: archivedAt,
    ...(branch.status !== 'closed' ? { status: 'closed', status_changed_at: archivedAt } : {}),
  });
  if (!row) throw new NotFoundError('Branch not found');

  await auditService.record(
    actor,
    AUDIT.branchArchive,
    target.branch(id),
    { name: branch.name, status: branch.status, archived_at: null },
    { name: row.name, status: row.status, archived_at: archivedAt.toISOString() },
  );

  return toWireBranch(row, await retirementFacts(row));
}

/**
 * Brings a branch back into the lists.
 *
 * It returns `closed`, not `active` — archiving set that status and this undoes
 * only the hiding. Reopening a branch is a separate decision with its own
 * consequences (it becomes assignable again), and folding it into "un-hide"
 * would make one click do two things, one of them unannounced.
 */
export async function unarchiveBranch(
  actor: RequestActorContext,
  id: number,
): Promise<WireBranch> {
  const branch = await branchesRepository.findById(id);
  if (!branch) throw new NotFoundError('Branch not found');
  if (branch.archived_at === null) return toWireBranch(branch, await retirementFacts(branch));

  const row = await branchesRepository.update(id, { archived_at: null });
  if (!row) throw new NotFoundError('Branch not found');

  await auditService.record(
    actor,
    AUDIT.branchUnarchive,
    target.branch(id),
    { archived_at: branch.archived_at.toISOString() },
    { archived_at: null },
  );

  return toWireBranch(row, await retirementFacts(row));
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

/**
 * Refuses a name another branch already holds — including an archived one.
 *
 * The index behind this is global, so an archived branch keeps its name, and
 * the admin who archived "فرع المزة" last month cannot see why creating it
 * again fails. Two message keys, not one, because the reader's next move
 * differs: a live clash means pick another name; an archived clash means the
 * branch they are recreating already exists and can be restored with its
 * history intact instead of started over as an empty duplicate.
 */
async function assertNameIsFree(name: string): Promise<void> {
  const existing = await branchesRepository.findByName(name);
  if (!existing) return;
  throw new BusinessError(
    409,
    existing.archived_at !== null
      ? `An archived branch (id ${existing.id}) already uses this name — restore it instead, or rename it.`
      : `Branch name "${name}" is already in use`,
    existing.archived_at !== null ? 'branch_name_taken_by_archived' : 'branch_name_taken',
  );
}

export async function createBranch(
  actor: RequestActorContext,
  body: CreateBranchBody,
): Promise<WireBranch> {
  await assertNameIsFree(body.name);

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

  // An archived branch is edited by first restoring it. Allowing edits through
  // would let `status: 'active'` reopen a branch that stays invisible in every
  // list — assignable in theory, unfindable in practice.
  if (existing.archived_at !== null) {
    throw new BusinessError(
      409,
      'This branch is archived. Restore it before editing.',
      'branch_archived',
    );
  }

  if (body.name !== undefined && body.name !== existing.name) {
    await assertNameIsFree(body.name);
  }

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
