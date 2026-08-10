import {
  NotFoundError,
  BusinessError,
  UnauthorizedError,
  ForbiddenError,
} from '../../../core/http/api-error.js';
import {
  paginated,
  type PaginationParams,
  type Paginated,
} from '../../../core/pagination/pagination.js';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../../../core/security/password.js';
import { passwordResetDelivery } from '../../../core/notifications/password-reset-delivery.js';
import { generateSessionToken } from '../../../core/security/token.js';
import * as usersRepository from '../repositories/users.repository.js';
import * as rolesRepository from '../repositories/roles.repository.js';
import * as assignmentsRepository from '../repositories/user-role-assignments.repository.js';
import * as ownershipsRepository from '../repositories/ownerships.repository.js';
import * as branchesRepository from '../repositories/branches.repository.js';
import * as sessionsRepository from '../repositories/sessions.repository.js';
import { SUPER_ADMIN_ROLE_NAME } from './roles.service.js';
import * as rolesService from './roles.service.js';
import * as assignmentsService from './user-role-assignments.service.js';
import * as auditService from './audit.service.js';
import { AUDIT, target } from './audit-actions.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import {
  toWireUser,
  type WireUser,
  type RegisterStaffBody,
  type DecideRegistrationBody,
  type LoginBody,
  type BootstrapSuperAdminBody,
  type UpdateUserBody,
  type CreateUserByAdminBody,
  type UsersFilterQuery,
  type ResubmitRegistrationBody,
  type ForgotPasswordBody,
  type ResetPasswordBody,
  type ChangePasswordBody,
} from '../dtos/users.dto.js';

const MAX_OWNERSHIP_PERCENTAGE = 100;

/** Renameable afterwards — this is a starting point, not a fixed identity. */
const DEFAULT_BRANCH_NAME = 'الفرع الرئيسي';

export async function listUsers(
  params: PaginationParams,
  filter: UsersFilterQuery,
): Promise<Paginated<WireUser>> {
  const { rows, total } = await usersRepository.findMany(params, filter);
  return paginated(rows.map(toWireUser), total, params);
}

export async function getUserById(id: number): Promise<WireUser> {
  const row = await usersRepository.findById(id);
  if (!row) throw new NotFoundError('User not found');
  return toWireUser(row);
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
 * Single self-registration entry point for every internal account (staff,
 * and optionally partner in the same request). Always lands in
 * pending_approval with zero active UserRoleAssignment — the account exists
 * but can reach nothing protected until an admin decides.
 * (users_roles.md — Feature: Internal Self-Registration & Approval, 2026-07-09)
 */
export async function registerStaff(body: RegisterStaffBody): Promise<WireUser> {
  const existing = await usersRepository.findByEmail(body.email);
  if (existing) {
    throw new BusinessError(409, 'An account with this email already exists', 'email_taken');
  }

  const role = await rolesRepository.findById(body.requested_role_id);
  if (!role) throw new NotFoundError('Requested role not found');

  const passwordHash = await hashPassword(body.password);

  const row = await usersRepository.insert({
    first_name: body.first_name,
    last_name: body.last_name,
    email: body.email,
    phone: body.phone,
    password_hash: passwordHash,
    status: 'pending_approval',
    requested_role_id: body.requested_role_id,
    requested_branch_id: body.requested_branch_id ?? null,
    requested_ownership_percentage:
      body.requested_ownership_percentage !== undefined
        ? body.requested_ownership_percentage.toFixed(2)
        : null,
  });

  return toWireUser(row);
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

export async function login(body: LoginBody): Promise<LoginResult> {
  const user = await usersRepository.findByEmail(body.email);
  if (!user) throw new UnauthorizedError('Invalid email or password', 'invalid_credentials');

  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) throw new UnauthorizedError('Invalid email or password', 'invalid_credentials');

  // pending_approval/rejected still get a real session — the account must
  // stay reachable (status screen, edit-and-resubmit) even after the app is
  // reinstalled and the original registration response is long gone. This
  // session unlocks nothing protected: requirePermission() looks up active
  // UserRoleAssignment rows, and these statuses never have one.
  // (users_roles.md — Feature: Internal Self-Registration & Approval)
  if (user.status === 'suspended') {
    throw new ForbiddenError(
      'Your account is temporarily suspended',
      { account_status: 'suspended' },
      'account_suspended',
    );
  }
  if (user.status === 'disabled') {
    throw new ForbiddenError(
      'Your account has been disabled',
      { account_status: 'disabled' },
      'account_disabled',
    );
  }

  const token = generateSessionToken();
  const session = await sessionsRepository.insert({
    user_id: user.id,
    token,
    device_info: body.device_info ?? null,
  });
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

/** Ends the current session only — other concurrent sessions for the same user are untouched (multi-session is allowed by design). */
export async function logout(token: string): Promise<void> {
  await sessionsRepository.deleteByToken(token);
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

// ── Password reset & change ──────────────────────────────────────────────────

/** Unambiguous alphabet: no O/0 or I/1, because this code gets read off a screen and typed. */
const RESET_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RESET_CODE_LENGTH = 8;
const RESET_CODE_TTL_MINUTES = 15;

function generateResetCode(): string {
  const bytes = randomBytes(RESET_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < RESET_CODE_LENGTH; i += 1) {
    out += RESET_CODE_ALPHABET[bytes[i]! % RESET_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Stored hashed, never in the clear.
 *
 * A reset code is a temporary password. If the users table leaks, plaintext
 * codes hand the attacker every account with a reset in flight — the one thing
 * the password column is hashed to prevent.
 *
 * SHA-256 rather than the password hasher: this value is high-entropy and
 * short-lived, so the slow salted KDF buys nothing and would add its cost to
 * every verification.
 */
function hashResetCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Step 1 — issue a reset code.
 *
 * ## Always resolves, even for an address with no account
 *
 * Answering "no such user" would turn this endpoint into a membership oracle:
 * anyone could test addresses one at a time and learn who has an account here.
 * So an unknown address takes the same path, returns the same shape, and the
 * caller cannot tell the difference.
 *
 * The same reasoning covers non-active accounts. A suspended user is told
 * nothing here — not because it would be unhelpful, but because "this account
 * exists and is suspended" is exactly the fact the oracle was after.
 */
export async function requestPasswordReset(body: ForgotPasswordBody): Promise<void> {
  const user = await usersRepository.findByEmail(body.email);

  // Deliberately silent: no error, no log, no different timing branch worth
  // measuring. The response is identical to the success path.
  if (!user || user.status === 'disabled' || user.status === 'rejected') return;

  const code = generateResetCode();
  await usersRepository.update(user.id, {
    password_reset_token: hashResetCode(code),
    password_reset_expires_at: new Date(Date.now() + RESET_CODE_TTL_MINUTES * 60_000),
  });

  await passwordResetDelivery.send(user.email, code);
}

/**
 * Step 2 — spend the code and set the new password.
 *
 * Every rejection below is the same error on purpose: wrong code, expired code,
 * already-used code, and unknown address are indistinguishable to the caller.
 * Telling them apart would let someone probe which addresses have a reset in
 * flight, and none of the four suggests a different action to a legitimate user
 * — they all mean "ask for a new code".
 */
export async function resetPassword(body: ResetPasswordBody): Promise<void> {
  const invalid = (): never => {
    throw new BusinessError(
      422,
      'This reset code is invalid or has expired',
      'reset_code_invalid',
    );
  };

  const user = await usersRepository.findByEmail(body.email);
  if (!user || !user.password_reset_token || !user.password_reset_expires_at) invalid();

  const row = user!;
  if (row.password_reset_expires_at!.getTime() < Date.now()) invalid();
  if (row.password_reset_token !== hashResetCode(body.token)) invalid();

  await usersRepository.update(row.id, {
    password_hash: await hashPassword(body.new_password),
    // Cleared in the same write that sets the password: a code that survives
    // its own use is a second, permanent password.
    password_reset_token: null,
    password_reset_expires_at: null,
  });

  // The reason someone resets a password is usually that someone else knows it.
  // Leaving existing sessions alive would mean the reset changed nothing for
  // whoever already had one.
  await sessionsRepository.deleteAllByUserId(row.id);
}

/**
 * Changing your own password while signed in.
 *
 * ## Why the wrong current password is a 422 and not a 401
 *
 * This request is authenticated, so a 401 means "your session is invalid" — and
 * every client treats that by signing the user out. Answering 401 for a mistyped
 * field would eject someone from the app for a typo, which reads as a crash
 * rather than a correction. The session is fine; one input was wrong.
 */
export async function changePassword(
  actorUserId: number,
  body: ChangePasswordBody,
): Promise<void> {
  const user = await usersRepository.findById(actorUserId);
  if (!user) throw new NotFoundError('User not found');

  const valid = await verifyPassword(body.current_password, user.password_hash);
  if (!valid) {
    throw new BusinessError(422, 'Your current password is incorrect', 'current_password_wrong');
  }

  if (body.current_password === body.new_password) {
    throw new BusinessError(
      422,
      'The new password must differ from the current one',
      'password_must_differ',
    );
  }

  await usersRepository.update(user.id, {
    password_hash: await hashPassword(body.new_password),
    // Any reset in flight is void: the account owner just proved they know the
    // password, so an outstanding code can only be someone else's attempt.
    password_reset_token: null,
    password_reset_expires_at: null,
  });

  // Sessions are NOT revoked here. The user is present and chose this; signing
  // their other devices out would be a surprise, not a protection.
}
