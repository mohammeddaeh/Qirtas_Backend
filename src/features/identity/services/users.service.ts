import { NotFoundError, BusinessError, ForbiddenError } from '../../../core/http/api-error.js';
import {
  paginated,
  type PaginationParams,
  type Paginated,
} from '../../../core/pagination/pagination.js';
import { hashPassword } from '../../../core/auth/services/password.service.js';
import * as authService from '../../../core/auth/services/auth.service.js';
import { isEmailVerificationEnabled } from '../../../core/auth/config/auth-config.js';
import { qirtasAccountStore } from '../repositories/account-store.impl.js';
import * as usersRepository from '../repositories/users.repository.js';
import * as rolesRepository from '../repositories/roles.repository.js';
import * as auditLogRepository from '../repositories/audit-log-entries.repository.js';
import type { RoleRow } from '../schemas/roles.schema.js';
import type { UserRow } from '../schemas/users.schema.js';
import * as assignmentsRepository from '../repositories/user-role-assignments.repository.js';
import * as ownershipsRepository from '../repositories/ownerships.repository.js';
import * as branchesRepository from '../repositories/branches.repository.js';
import { SUPER_ADMIN_ROLE_NAME } from './roles.service.js';
import * as rolesService from './roles.service.js';
import * as assignmentsService from './user-role-assignments.service.js';
import * as auditService from './audit.service.js';
import { AUDIT, target } from './audit-actions.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import {
  toWireUser,
  type WireUser,
  type UserRetirementFacts,
  type RegisterStaffBody,
  type DecideRegistrationBody,
  type LoginBody,
  type BootstrapSuperAdminBody,
  type UpdateUserBody,
  type CreateUserByAdminBody,
  type UsersFilterQuery,
  type ResubmitRegistrationBody,
} from '../dtos/users.dto.js';

const MAX_OWNERSHIP_PERCENTAGE = 100;

/** Renameable afterwards — this is a starting point, not a fixed identity. */
const DEFAULT_BRANCH_NAME = 'الفرع الرئيسي';

/**
 * Every row carries `current_posts` — where that person works right now.
 *
 * Costs exactly one extra query per page (never per row), and it is what turns
 * a list of names into a list of decisions: picking someone to fill a post
 * means knowing whether you are placing an unassigned person or pulling a
 * cashier out of another branch.
 */
export async function listUsers(
  params: PaginationParams,
  filter: UsersFilterQuery,
): Promise<Paginated<WireUser>> {
  const { rows, total } = await usersRepository.findMany(params, filter);
  const postsByUser = await assignmentsRepository.findActivePostsForUsers(rows.map((r) => r.id));

  return paginated(
    // `?? []` and never `undefined`: an empty array says "belongs nowhere",
    // which the picker renders as «بلا منصب». Omitting the field would say
    // "this response does not carry posts" — a different claim the client
    // cannot draw anything from.
    rows.map((row) => ({ ...toWireUser(row), current_posts: postsByUser.get(row.id) ?? [] })),
    total,
    params,
  );
}

export async function getUserById(id: number): Promise<WireUser> {
  const row = await usersRepository.findById(id);
  if (!row) throw new NotFoundError('User not found');
  return toWireUser(row, await retirementFacts(row));
}

/**
 * What removing this account would run into — computed by exactly the rules
 * [deleteUser] and [archiveUser] enforce, so the screen offers each action only
 * where it succeeds and can say why when it does not.
 *
 * Five numbers rather than two booleans because the refusals are otherwise
 * indistinguishable on screen. An account with no assignments and no ownerships
 * looks plainly deletable; if it once signed in, `audit_entries_count` is the
 * only thing that explains why it is not, and without it the admin re-checks a
 * staff list that was never the obstacle.
 */
async function retirementFacts(row: UserRow): Promise<UserRetirementFacts> {
  const [openAssignments, assignmentsEver, openOwnerships, ownershipsEver, auditEntries] =
    await Promise.all([
      assignmentsRepository.countOpenForUser(row.id),
      assignmentsRepository.countAssignmentsEverForUser(row.id),
      ownershipsRepository.countOpenForUser(row.id),
      ownershipsRepository.countEverForUser(row.id),
      auditLogRepository.countByActor(row.id),
    ]);

  return {
    is_deletable:
      !row.is_root_protected &&
      assignmentsEver === 0 &&
      ownershipsEver === 0 &&
      auditEntries === 0,
    is_archivable:
      !row.is_root_protected &&
      row.archived_at === null &&
      openAssignments === 0 &&
      openOwnerships === 0,
    open_assignments_count: openAssignments,
    assignments_ever_count: assignmentsEver,
    audit_entries_count: auditEntries,
  };
}

/**
 * The root account is exempt from both exits — the same rule every other
 * mutation on this service already applies, restated here only because these
 * two are the ones that would be unrecoverable.
 */
function assertNotRootProtected(row: UserRow): void {
  if (!row.is_root_protected) return;
  throw new ForbiddenError(
    'This account is root-protected and cannot be removed',
    undefined,
    'user_root_protected',
  );
}

/**
 * Nobody removes their own account through the admin screens.
 *
 * Not vanity: archiving forces `disabled`, and disabling yourself ends your own
 * access mid-action — the response would arrive on a screen that no longer has
 * the right to be open, and if you were the last administrator, nobody can undo
 * it. `assertNotLastAdministrator` guards the assignment path; this guards the
 * shorter route to the same place.
 */
function assertNotSelf(actorUserId: number, targetId: number): void {
  if (actorUserId !== targetId) return;
  throw new ForbiddenError(
    'You cannot remove your own account',
    undefined,
    'user_cannot_remove_self',
  );
}

/**
 * Destroys an account nothing was ever recorded against.
 *
 * The narrow case, and narrower than it looks: `audit_log_entries.user_id` is
 * `RESTRICT`, so anyone who has ever signed in has an entry to their name and
 * is permanently undeletable. What is left is genuinely an account created by
 * mistake — a typo'd address, a duplicate — which had no way off the list
 * before this and would otherwise sit in it forever wearing `disabled`.
 *
 * Assignments and ownerships CASCADE, so the database would happily take
 * someone's employment record along with the row. That is exactly why both are
 * counted here first: the check is not a formality ahead of a constraint that
 * would have caught it anyway — it is the only thing standing between "delete
 * the empty account" and "delete the record of where somebody worked".
 */
export async function deleteUser(actor: RequestActorContext, userId: number): Promise<void> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  assertNotRootProtected(user);
  assertNotSelf(actor.userId, userId);

  const auditEntries = await auditLogRepository.countByActor(userId);
  if (auditEntries > 0) {
    throw new BusinessError(
      409,
      `This account has ${auditEntries} audit entr(ies) recorded against it and cannot be deleted. Archive it instead.`,
      'user_has_audit_history',
    );
  }

  const [assignmentsEver, ownershipsEver] = await Promise.all([
    assignmentsRepository.countAssignmentsEverForUser(userId),
    ownershipsRepository.countEverForUser(userId),
  ]);
  if (assignmentsEver > 0 || ownershipsEver > 0) {
    throw new BusinessError(
      409,
      `This account has ${assignmentsEver} assignment(s) and ${ownershipsEver} ownership record(s) in its history. Archive it instead — deleting would erase where this person worked.`,
      'user_has_history',
    );
  }

  // Before the delete: afterwards there is no row to describe, and naming who
  // disappeared is the entry's whole value. Safe despite the RESTRICT above —
  // the actor is the admin, and the account being deleted is the target, which
  // `target_entity` holds as text with no foreign key.
  await auditService.record(
    actor,
    AUDIT.userDelete,
    target.user(userId),
    { full_name: `${user.first_name} ${user.last_name}`.trim(), email: user.email },
    null,
  );

  await usersRepository.deleteById(userId);
}

/**
 * Retires an account that HAS a past — off the lists, signed out, and locked
 * out, with everything it ever did still attributed to a real person.
 *
 * `status: 'disabled'` is written in the same statement, never separately. It
 * is what makes archiving safe to define as "hidden": the sign-in gate stays
 * the one gate, so a hidden row cannot also be a live one — invisible to the
 * admin reviewing accounts and still opening sessions. It also disposes of an
 * open session without this service having to reach for the session store:
 * `core/middleware/auth.ts` re-runs `canSignIn` on every request and deletes
 * the session the moment it refuses, exactly as it does for `disableUser`.
 *
 * The bar is no OPEN assignment and no OPEN ownership. Closed ones are the
 * history being preserved, and they keep resolving to this row.
 */
export async function archiveUser(
  actor: RequestActorContext,
  userId: number,
): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  // Idempotent — the caller's intent already holds.
  if (user.archived_at !== null) return toWireUser(user, await retirementFacts(user));

  assertNotRootProtected(user);
  assertNotSelf(actor.userId, userId);

  const [openAssignments, openOwnerships] = await Promise.all([
    assignmentsRepository.countOpenForUser(userId),
    ownershipsRepository.countOpenForUser(userId),
  ]);
  if (openAssignments > 0) {
    throw new BusinessError(
      409,
      `This person still holds ${openAssignments} active assignment(s). End or transfer them before archiving the account.`,
      'user_has_active_assignments',
    );
  }
  if (openOwnerships > 0) {
    throw new BusinessError(
      409,
      `This person still holds ${openOwnerships} active ownership record(s). End them before archiving the account.`,
      'user_has_active_ownerships',
    );
  }

  const archivedAt = new Date();
  const row = await usersRepository.update(userId, {
    archived_at: archivedAt,
    status: 'disabled',
  });
  if (!row) throw new NotFoundError('User not found');

  await auditService.record(
    actor,
    AUDIT.userArchive,
    target.user(userId),
    { status: user.status, archived_at: null },
    { status: row.status, archived_at: archivedAt.toISOString() },
  );

  return toWireUser(row, await retirementFacts(row));
}

/**
 * Puts an archived account back on the lists — still disabled.
 *
 * Restoring undoes the hiding and nothing else. `disabled` was written by
 * archiving and stays, so reinstating someone remains the deliberate,
 * separately-audited act it already is (`reactivateUser`). Folding the two
 * together would make one click restore an account AND grant it access, with
 * only the first half announced.
 */
export async function unarchiveUser(
  actor: RequestActorContext,
  userId: number,
): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  if (user.archived_at === null) return toWireUser(user, await retirementFacts(user));

  const row = await usersRepository.update(userId, { archived_at: null });
  if (!row) throw new NotFoundError('User not found');

  await auditService.record(
    actor,
    AUDIT.userUnarchive,
    target.user(userId),
    { archived_at: user.archived_at.toISOString() },
    { archived_at: null },
  );

  return toWireUser(row, await retirementFacts(row));
}

/**
 * Refuses every write to an archived account — applied at each mutation entry.
 *
 * The dangerous one is `reactivateUser`: it would clear `disabled` and leave an
 * account that is active, invisible in every list, and able to sign in. Restore
 * first, so the change lands where someone can see it.
 */
function assertNotArchived(row: UserRow): void {
  if (row.archived_at === null) return;
  throw new BusinessError(
    409,
    'This account is archived. Restore it before editing.',
    'user_archived',
  );
}

/**
 * Edits identity/profile fields only (first/last name, email, phone) —
 * status transitions go through suspend/disable/reactivate/decide-registration,
 * password change is a separate out-of-scope flow, neither is touched here.
 */
export async function updateUser(
  actor: RequestActorContext,
  id: number,
  body: UpdateUserBody,
): Promise<WireUser> {
  const existing = await usersRepository.findById(id);
  if (!existing) throw new NotFoundError('User not found');

  assertNotArchived(existing);

  if (existing.is_root_protected) {
    throw new ForbiddenError(
      'This account is root-protected and cannot be modified',
      undefined,
      'user_root_protected',
    );
  }

  if (body.email !== undefined && body.email !== existing.email) {
    const conflict = await usersRepository.existsByEmailExcluding(body.email, id);
    if (conflict) {
      throw new BusinessError(409, 'An account with this email already exists', 'email_taken');
    }
  }

  const row = await usersRepository.update(id, {
    ...(body.first_name !== undefined ? { first_name: body.first_name } : {}),
    ...(body.last_name !== undefined ? { last_name: body.last_name } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
  });
  if (!row) throw new NotFoundError('User not found');

  // Identity fields only — no password_hash reaches the log, by construction:
  // this endpoint cannot change it (password has its own path).
  await auditService.record(
    actor,
    AUDIT.userUpdate,
    target.user(id),
    {
      first_name: existing.first_name,
      last_name: existing.last_name,
      email: existing.email,
      phone: existing.phone,
    },
    {
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      phone: row.phone,
    },
  );
  return toWireUser(row);
}

/**
 * Refuses a requested role that is not in the self-registration catalog
 * (`GET /roles/self-registerable`) — same predicate, so the write path enforces
 * exactly what the public list offers.
 *
 * The list is the only place a visitor picks from, but nothing stops a crafted
 * body naming any id at all. Without this, a stranger could file a request for
 * Super Admin: harmless in itself (an admin still decides, and the account
 * holds no assignment until then), but it puts a line into the review queue
 * that exists only to be rejected.
 */
function assertSelfRegisterable(role: RoleRow): void {
  if (rolesRepository.isSelfRegisterable(role)) return;
  throw new BusinessError(
    422,
    'This role cannot be requested at registration',
    'role_not_self_registerable',
  );
}

/**
 * Single self-registration entry point for every internal account (staff,
 * and optionally partner in the same request). Lands in pending_verification
 * (or pending_approval where verification is off) with zero active
 * UserRoleAssignment — the account exists but can reach nothing protected
 * until an admin decides.
 * (users_roles.md — Feature: Internal Self-Registration & Approval, 2026-07-09)
 *
 * Returns the same shape as `login()`, session included — see the block above
 * the return statement for why.
 */
export async function registerStaff(
  body: RegisterStaffBody,
  origin: authService.RequestOrigin,
): Promise<LoginResult> {
  const existing = await usersRepository.findByEmail(body.email);
  if (existing) {
    throw new BusinessError(409, 'An account with this email already exists', 'email_taken');
  }

  const role = await rolesRepository.findById(body.requested_role_id);
  if (!role) throw new NotFoundError('Requested role not found');
  assertSelfRegisterable(role);

  // ## Where a new registration lands, and why
  //
  // With verification enabled the account starts at `pending_verification` and
  // does NOT enter the admin review queue — it advances to `pending_approval`
  // only when the code is spent (AccountStore.markEmailVerified). That ordering
  // is the point: the queue is an admin's working tool, and without this gate
  // anyone could fill it with thousands of addresses they do not own. Proving
  // the address costs an attacker a real mailbox per request.
  //
  // With verification off the account lands where it always did, so a
  // deployment that upgrades this backend without configuring SMTP behaves
  // exactly as before rather than stranding every new registration behind an
  // email that cannot be sent.
  const verificationEnabled = isEmailVerificationEnabled();
  const now = new Date();

  const account = await qirtasAccountStore.create({
    email: body.email,
    passwordHash: await hashPassword(body.password),
    emailVerifiedAt: verificationEnabled ? null : now,
    profile: {
      first_name: body.first_name,
      last_name: body.last_name,
      phone: body.phone,
      status: verificationEnabled ? 'pending_verification' : 'pending_approval',
      requested_role_id: body.requested_role_id,
      requested_branch_id: body.requested_branch_id ?? null,
      requested_ownership_percentage: body.requested_ownership_percentage ?? null,
    },
  });

  // After the row exists, never before: a code that reaches the user but not
  // the database is unverifiable, while the reverse costs one resend.
  await authService.sendEmailVerification(account, origin);

  // ## Why registration hands back a session
  //
  // The code screen is inside the app, and `POST /auth/verify-email` is
  // `requireAuth` — so without a session here, the one thing this response asks
  // the user to do is the one thing they cannot do. The client used to bridge
  // the gap by sending them to the sign-in screen to type the credentials they
  // had just typed, which is the same round trip with an extra form.
  //
  // It grants nothing new: this account could call `POST /users/login` a second
  // later and be handed exactly this token — an unverified/unapproved account
  // holds no active assignment, so `permission_keys` is empty and the session
  // unlocks only the code screen. Issuing it through `login()` rather than
  // creating a session directly is deliberate: the sign-in refusals
  // (`AccountStore.canSignIn`), the security event, and the permission lookup
  // stay in one place, so this path can never drift from the real one.
  return login({ email: body.email, password: body.password }, origin);
}

/**
 * Lets a `rejected` account submit a new request without changing email/
 * password/name — only the requested role/branch/ownership% can change.
 * Flips status back to pending_approval and clears the previous decision
 * (reason/decided_at/decided_by), same as a fresh registerStaff row.
 * (users_roles.md — Feature: Internal Self-Registration & Approval — "the
 * person can see the rejection reason and resubmit a new request")
 */
export async function resubmitRegistration(
  userId: number,
  body: ResubmitRegistrationBody,
): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  if (user.status !== 'rejected') {
    throw new BusinessError(
      409,
      `Only a rejected registration can be resubmitted (current status: ${user.status})`,

      'registration_not_rejected',
    );
  }

  const role = await rolesRepository.findById(body.requested_role_id);
  if (!role) throw new NotFoundError('Requested role not found');
  assertSelfRegisterable(role);

  const row = await usersRepository.update(userId, {
    status: 'pending_approval',
    requested_role_id: body.requested_role_id,
    requested_branch_id: body.requested_branch_id ?? null,
    requested_ownership_percentage:
      body.requested_ownership_percentage !== undefined
        ? body.requested_ownership_percentage.toFixed(2)
        : null,
    rejection_reason: null,
    decided_at: null,
    decided_by_user_id: null,
  });
  if (!row) throw new NotFoundError('User not found');

  return toWireUser(row);
}

/**
 * Admin-direct creation — distinct from registerStaff above (self-service +
 * later review). Here the admin creating the account IS the approval: the
 * account lands at status=active immediately, with role/branch/ownership
 * assigned in the same call — mirroring exactly what decideRegistration's
 * approve branch does to a pending_approval account, just in one step
 * instead of two. Never reuse/conflate with registerStaff.
 */
export async function createUserByAdmin(
  actor: RequestActorContext,
  body: CreateUserByAdminBody,
): Promise<WireUser> {
  const createdByUserId = actor.userId;
  const existing = await usersRepository.findByEmail(body.email);
  if (existing) {
    throw new BusinessError(409, 'An account with this email already exists', 'email_taken');
  }

  const role = await rolesRepository.findById(body.role_id);
  if (!role) throw new NotFoundError('Role not found');
  if (!role.is_active) {
    throw new BusinessError(422, 'Cannot assign an inactive role', 'role_inactive_unassignable');
  }

  if (body.ownership_percentage !== undefined) {
    const currentSum = await ownershipsRepository.sumActivePercentage(body.branch_id ?? null);
    if (currentSum + body.ownership_percentage > MAX_OWNERSHIP_PERCENTAGE) {
      throw new BusinessError(
        422,
        `Assigning ${body.ownership_percentage}% ownership would push the scope total to ${currentSum + body.ownership_percentage}%, exceeding the 100% cap.`,

        'ownership_sum_exceeded',
      );
    }
  }

  const passwordHash = await hashPassword(body.password);

  const row = await usersRepository.insert({
    first_name: body.first_name,
    last_name: body.last_name,
    email: body.email,
    phone: body.phone,
    password_hash: passwordHash,
    status: 'active',
    // Verified without a code, because the admin creating the account IS the
    // proof — they typed the address, they know the person, and the account is
    // active from this moment. Sending a code the new employee must find before
    // they can be assigned anything would gate an admin's deliberate act on a
    // mailbox neither of them is watching. Verification exists to stop
    // *self*-registration from being anonymous; there is nothing anonymous here.
    email_verified_at: new Date(),
    decided_at: new Date(),
    decided_by_user_id: createdByUserId,
  });

  await assignmentsRepository.insert({
    user_id: row.id,
    role_id: body.role_id,
    branch_id: body.branch_id ?? null,
  });

  if (body.ownership_percentage !== undefined) {
    await ownershipsRepository.insert({
      user_id: row.id,
      percentage: body.ownership_percentage.toFixed(2),
      branch_scope: body.branch_id ?? null,
    });
  }

  // previous = null: the account did not exist before this call.
  await auditService.record(actor, AUDIT.userCreate, target.user(row.id), null, {
    email: row.email,
    status: row.status,
    role_id: body.role_id,
    branch_id: body.branch_id ?? null,
    ownership_percentage: body.ownership_percentage ?? null,
  });
  return toWireUser(row);
}

/**
 * Admin decision on a pending_approval account.
 * - approve: activates the account and opens the UserRoleAssignment (and
 *   Ownership record if requested) — using the admin's chosen role/branch/
 *   percentage, which may differ from what was originally requested.
 * - reject: account stays reachable (status=rejected) with a mandatory
 *   reason; the person can log in to see it and submit a new request.
 */
export async function decideRegistration(
  actor: RequestActorContext,
  userId: number,
  decision: DecideRegistrationBody,
): Promise<WireUser> {
  const decidedByUserId = actor.userId;
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  if (user.status !== 'pending_approval') {
    throw new BusinessError(
      409,
      `This account is not pending approval (current status: ${user.status})`,

      'registration_not_pending',
    );
  }

  if (decision.decision === 'reject') {
    const row = await usersRepository.update(userId, {
      status: 'rejected',
      rejection_reason: decision.reason,
      decided_at: new Date(),
      decided_by_user_id: decidedByUserId,
    });
    if (!row) throw new NotFoundError('User not found');
    // The reason is logged with the decision: a rejection without its stated
    // reason is unreviewable later, and the reason is the decision's substance.
    await auditService.record(
      actor,
      AUDIT.userRegistrationDecide,
      target.user(userId),
      { status: user.status },
      { status: row.status, decision: 'reject', reason: decision.reason },
    );
    return toWireUser(row);
  }

  const roleId = decision.role_id ?? user.requested_role_id;
  if (!roleId)
    throw new BusinessError(
      422,
      'A role must be specified to approve this registration',
      'registration_role_required',
    );
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  const branchId = decision.branch_id !== undefined ? decision.branch_id : user.requested_branch_id;
  const ownershipPercentage =
    decision.ownership_percentage !== undefined
      ? decision.ownership_percentage
      : user.requested_ownership_percentage !== null
        ? Number(user.requested_ownership_percentage)
        : undefined;

  if (ownershipPercentage !== undefined) {
    const currentSum = await ownershipsRepository.sumActivePercentage(branchId ?? null);
    if (currentSum + ownershipPercentage > MAX_OWNERSHIP_PERCENTAGE) {
      throw new BusinessError(
        422,
        `Approving with ${ownershipPercentage}% ownership would push the scope total to ${currentSum + ownershipPercentage}%, exceeding the 100% cap.`,

        'ownership_sum_exceeded',
      );
    }
  }

  const row = await usersRepository.update(userId, {
    status: 'active',
    decided_at: new Date(),
    decided_by_user_id: decidedByUserId,
  });
  if (!row) throw new NotFoundError('User not found');

  await assignmentsRepository.insert({
    user_id: userId,
    role_id: roleId,
    branch_id: branchId ?? null,
  });

  if (ownershipPercentage !== undefined) {
    await ownershipsRepository.insert({
      user_id: userId,
      percentage: ownershipPercentage.toFixed(2),
      branch_scope: branchId ?? null,
    });
  }

  // Records what was actually granted, not what was requested — the admin may
  // approve with a different role/branch/percentage than the applicant asked
  // for, and the granted values are the ones that need answering for.
  await auditService.record(
    actor,
    AUDIT.userRegistrationDecide,
    target.user(userId),
    { status: user.status },
    {
      status: row.status,
      decision: 'approve',
      role_id: roleId,
      branch_id: branchId ?? null,
      ownership_percentage: ownershipPercentage ?? null,
    },
  );
  return toWireUser(row);
}

/** First-run bootstrap — only callable while zero User rows exist at all. */
export async function bootstrapSuperAdmin(body: BootstrapSuperAdminBody): Promise<WireUser> {
  const existingCount = await usersRepository.countAll();
  if (existingCount > 0) {
    throw new ForbiddenError(
      'Setup has already been completed — bootstrap is only available on a fresh install',
      undefined,
      'setup_already_completed',
    );
  }

  const superAdminRole = await rolesRepository.findActiveByName(SUPER_ADMIN_ROLE_NAME);
  if (!superAdminRole) {
    throw new BusinessError(
      500,
      'Super Admin role is not seeded — run the seed script before bootstrapping',

      'super_admin_role_not_seeded',
    );
  }

  const passwordHash = await hashPassword(body.password);
  const row = await usersRepository.insert({
    first_name: body.first_name,
    last_name: body.last_name,
    email: body.email,
    phone: body.phone,
    password_hash: passwordHash,
    is_admin: true,
    status: 'active',
    // Same reasoning as createUserByAdmin, more sharply: this runs on an empty
    // database, so there is no mail configured yet and nobody to approve
    // anything. Gating first-run setup behind an email would make a fresh
    // install unbootstrappable.
    email_verified_at: new Date(),
    decided_at: new Date(),
    // The ONLY code path in the whole codebase allowed to set this to true
    // (docs/reference/users_roles.md — Feature: Root Protected Account).
    // Never sourced from request body — this literal is the sole origin.
    is_root_protected: true,
  });

  await assignmentsRepository.insert({
    user_id: row.id,
    role_id: superAdminRole.id,
    branch_id: null,
  });
  await ownershipsRepository.insert({
    user_id: row.id,
    percentage: '100.00',
    branch_scope: null,
  });

  // A fresh install with zero branches cannot place its first employee
  // anywhere, so the system starts unusable — contradicting the settled
  // decision that it begins with one default branch
  // (users_roles.md; production_readiness.md §B4).
  //
  // Guarded rather than unconditional: bootstrap gates on zero *users*, and a
  // deployment could conceivably have branches seeded before its first
  // account. Creating a second "Main Branch" there would be worse than
  // creating none.
  const branchCount = await branchesRepository.countAll();
  if (branchCount === 0) {
    await branchesRepository.insert({
      name: DEFAULT_BRANCH_NAME,
      is_default: true,
    });
  }

  return toWireUser(row);
}

export interface LoginResult {
  user: WireUser;
  token: string;
  session_id: number;
  permission_keys: string[];
  /** See [CurrentUserResult.is_super_admin]. */
  is_super_admin: boolean;
}

/** Shape shared by login() and getCurrentUser() — same {user, permission_keys} pair, minus the session-only fields (token/session_id). */
export interface CurrentUserResult {
  user: WireUser;
  permission_keys: string[];
  /**
   * Whether the caller actually holds the Super Admin role.
   *
   * Sent because two operations are gated on it and **no permission key
   * expresses it** — changing a role's authority level (`PUT /roles/:id/level`)
   * and being the protected root account. Without this the client either hides
   * a control every Super Admin needs, or offers one that everyone else is
   * refused — the same "let the user choose, then tell them they may not"
   * problem `?assignable=true` exists to avoid on roles.
   *
   * Computed by the same lookup the guard uses, so the client restates no rule
   * of its own and cannot drift from the server's answer.
   */
  is_super_admin: boolean;
}

/**
 * Sign-in — authentication delegated, authorization added here.
 *
 * ## Why this stayed in identity instead of moving to features/auth
 *
 * The response carries `permission_keys` and `is_super_admin`, which are
 * authorization facts derived from role assignments. `core/auth` must not know
 * that roles exist — the moment it does, the engine stops being portable to an
 * application without them. So the split follows the two questions:
 * `core/auth` answers "who is this and may they hold a session?", and this
 * function answers "and what may they do?".
 *
 * Everything that used to be inline here — credential checking, the constant-
 * time miss, the account-status refusals, session creation, the security event
 * — now lives in `authService.signIn`. The status rules did not disappear: they
 * moved to `AccountStore.canSignIn` in `repositories/account-store.impl.ts`,
 * where they remain Qirtas's, and where the auth middleware can re-check them
 * on every request rather than only at sign-in.
 */
export async function login(body: LoginBody, origin: authService.RequestOrigin): Promise<LoginResult> {
  const { account, session, token } = await authService.signIn(
    { email: body.email, password: body.password },
    { ...origin, deviceInfo: body.device_info ?? origin.deviceInfo },
  );

  const user = await usersRepository.findById(account.id);
  // The engine just authenticated against this row, so its absence here would
  // mean it vanished mid-request. Defensive, and never expected.
  if (!user) throw new NotFoundError('User not found');

  const permissionKeys = await assignmentsRepository.findAllEffectivePermissionKeys(user.id);

  // `is_super_admin` here too, not only on `getCurrentUser`: the client seeds
  // its session from THIS response, so omitting it would leave the flag false
  // until the next background refresh — a control that appears one restart
  // late reads as a bug, not as a delay.
  return {
    user: toWireUser(user),
    token,
    session_id: session.id,
    permission_keys: permissionKeys,
    is_super_admin: await rolesService.actorHoldsSuperAdmin(user.id),
  };
}

/**
 * Returns the calling user's own data + current effective permission keys —
 * same shape login() returns (minus token/session_id, not needed here).
 * Backs GET /users/me, the silent background-refresh endpoint the frontend
 * polls after restoring a cached session (docs/reference/
 * session_permission_integrity.md §6/§10). Defensive NotFoundError: with a
 * valid session this should never trigger, but the user row could in theory
 * vanish between session creation and this call.
 */
export async function getCurrentUser(userId: number): Promise<CurrentUserResult> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const permissionKeys = await assignmentsRepository.findAllEffectivePermissionKeys(user.id);
  return {
    user: toWireUser(user),
    permission_keys: permissionKeys,
    is_super_admin: await rolesService.actorHoldsSuperAdmin(user.id),
  };
}

/**
 * What another person can actually do — the union of every permission their
 * active assignments grant.
 *
 * Separate from the user record rather than a field on it: this is derived from
 * assignments, it can be long, and most reads of a user do not need it. It is
 * also the only honest answer to "what does this role mean for THIS person",
 * since one individual may hold several roles whose permissions overlap.
 */
export async function getUserPermissions(userId: number): Promise<string[]> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  return assignmentsRepository.findAllEffectivePermissionKeys(userId);
}

/** Ends the current session only — other concurrent sessions for the same user are untouched (multi-session is allowed by design). Delegated so the logout security event is recorded in one place. */
export async function logout(token: string, origin: authService.RequestOrigin): Promise<void> {
  await authService.signOut(token, origin);
}

/**
 * Temporary, reversible hold (investigation, long leave) — distinct from
 * disable (permanent/manual offboarding).
 *
 * Subject to the "last qualified staff" guard: a suspended account is
 * explicitly NOT counted as an available replacement (users_roles.md §Flow.6),
 * so suspending the only holder of a role in an operating branch empties that
 * role exactly as ending the assignment would.
 */
export async function suspendUser(actor: RequestActorContext, userId: number): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  assertNotArchived(user);
  if (user.is_root_protected) {
    throw new ForbiddenError(
      'This account is root-protected and cannot be modified',
      undefined,
      'user_root_protected',
    );
  }
  await assignmentsService.assertUserIsReleasable(userId);

  const row = await usersRepository.update(userId, { status: 'suspended' });
  if (!row) throw new NotFoundError('User not found');
  await auditService.record(
    actor,
    AUDIT.userSuspend,
    target.user(userId),
    { status: user.status },
    { status: row.status },
  );
  return toWireUser(row);
}

/**
 * Permanent offboarding path — historical records stay attributed to this user
 * forever. Never a hard delete.
 *
 * Same guard as [suspendUser]: disabling ends every assignment this person
 * holds at once, so it must clear the bar that ending a single one does.
 */
export async function disableUser(actor: RequestActorContext, userId: number): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  assertNotArchived(user);
  if (user.is_root_protected) {
    throw new ForbiddenError(
      'This account is root-protected and cannot be modified',
      undefined,
      'user_root_protected',
    );
  }
  await assignmentsService.assertUserIsReleasable(userId);

  const row = await usersRepository.update(userId, { status: 'disabled' });
  if (!row) throw new NotFoundError('User not found');
  await auditService.record(
    actor,
    AUDIT.userDisable,
    target.user(userId),
    { status: user.status },
    { status: row.status },
  );
  return toWireUser(row);
}

/**
 * Re-activation of a suspended or previously-disabled account — no new
 * account is ever created for a returning employee. A root-protected account
 * should never reach suspended/disabled in the first place (suspend/disable
 * above reject it unconditionally), so this guard is defensive/moot in
 * practice — kept only for consistency with the other three mutation paths.
 */
export async function reactivateUser(
  actor: RequestActorContext,
  userId: number,
): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  // The most important of the four: without it, reactivating would clear
  // `disabled` and leave an account that is active, able to sign in, and
  // present in no list any admin browses.
  assertNotArchived(user);
  if (user.is_root_protected) {
    throw new ForbiddenError(
      'This account is root-protected and cannot be modified',
      undefined,
      'user_root_protected',
    );
  }
  if (user.status !== 'suspended' && user.status !== 'disabled') {
    throw new BusinessError(
      409,
      `Cannot reactivate a user with status "${user.status}"`,
      'user_status_not_reactivatable',
    );
  }
  const row = await usersRepository.update(userId, { status: 'active' });
  if (!row) throw new NotFoundError('User not found');
  await auditService.record(
    actor,
    AUDIT.userReactivate,
    target.user(userId),
    { status: user.status },
    { status: row.status },
  );
  return toWireUser(row);
}

/**
 * Password reset and change moved to `core/auth/services/auth.service.ts`
 * (2026-08-11) and are served by `features/auth`.
 *
 * They were never identity concerns: nothing in them touches a role, a branch
 * or an approval. Keeping them here meant the reusable half of the system
 * depended on the Qirtas-specific half, which is what kept the template from
 * shipping a working authentication module.
 *
 * The deprecated `/users/forgot-password`, `/users/reset-password` and
 * `/users/change-password` routes still exist and delegate to the same
 * service, so no client breaks on the move.
 */
