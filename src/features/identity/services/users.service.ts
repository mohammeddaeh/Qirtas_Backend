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
import { hashPassword, verifyPassword } from '../../../core/security/password.js';
import * as usersRepository from '../repositories/users.repository.js';
import * as rolesRepository from '../repositories/roles.repository.js';
import * as assignmentsRepository from '../repositories/user-role-assignments.repository.js';
import * as ownershipsRepository from '../repositories/ownerships.repository.js';
import * as sessionsRepository from '../repositories/sessions.repository.js';
import { SUPER_ADMIN_ROLE_NAME } from './roles.service.js';
import {
  toWireUser,
  type WireUser,
  type RegisterStaffBody,
  type DecideRegistrationBody,
  type LoginBody,
  type BootstrapSuperAdminBody,
} from '../dtos/users.dto.js';

const MAX_OWNERSHIP_PERCENTAGE = 100;

export async function listUsers(params: PaginationParams): Promise<Paginated<WireUser>> {
  const { rows, total } = await usersRepository.findMany(params);
  return paginated(rows.map(toWireUser), total, params);
}

export async function getUserById(id: number): Promise<WireUser> {
  const row = await usersRepository.findById(id);
  if (!row) throw new NotFoundError('User not found');
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
    throw new BusinessError(409, 'An account with this email already exists');
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
 * Admin decision on a pending_approval account.
 * - approve: activates the account and opens the UserRoleAssignment (and
 *   Ownership record if requested) — using the admin's chosen role/branch/
 *   percentage, which may differ from what was originally requested.
 * - reject: account stays reachable (status=rejected) with a mandatory
 *   reason; the person can log in to see it and submit a new request.
 */
export async function decideRegistration(
  decidedByUserId: number,
  userId: number,
  decision: DecideRegistrationBody,
): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  if (user.status !== 'pending_approval') {
    throw new BusinessError(
      409,
      `This account is not pending approval (current status: ${user.status})`,
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
    return toWireUser(row);
  }

  const roleId = decision.role_id ?? user.requested_role_id;
  if (!roleId)
    throw new BusinessError(422, 'A role must be specified to approve this registration');
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

  return toWireUser(row);
}

/** First-run bootstrap — only callable while zero User rows exist at all. */
export async function bootstrapSuperAdmin(body: BootstrapSuperAdminBody): Promise<WireUser> {
  const existingCount = await usersRepository.countAll();
  if (existingCount > 0) {
    throw new ForbiddenError(
      'Setup has already been completed — bootstrap is only available on a fresh install',
    );
  }

  const superAdminRole = await rolesRepository.findActiveByName(SUPER_ADMIN_ROLE_NAME);
  if (!superAdminRole) {
    throw new BusinessError(
      500,
      'Super Admin role is not seeded — run the seed script before bootstrapping',
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

  return toWireUser(row);
}

export interface LoginResult {
  user: WireUser;
  session_id: number;
}

export async function login(body: LoginBody): Promise<LoginResult> {
  const user = await usersRepository.findByEmail(body.email);
  if (!user) throw new UnauthorizedError('Invalid email or password');

  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) throw new UnauthorizedError('Invalid email or password');

  if (user.status === 'pending_approval') {
    throw new ForbiddenError('Your registration is still pending admin approval');
  }
  if (user.status === 'rejected') {
    throw new ForbiddenError(user.rejection_reason ?? 'Your registration request was rejected');
  }
  if (user.status === 'suspended') {
    throw new ForbiddenError('Your account is temporarily suspended');
  }
  if (user.status === 'disabled') {
    throw new ForbiddenError('Your account has been disabled');
  }

  const session = await sessionsRepository.insert({
    user_id: user.id,
    device_info: body.device_info ?? null,
  });

  return { user: toWireUser(user), session_id: session.id };
}

/** Temporary, reversible hold (investigation, long leave) — distinct from disable (permanent/manual offboarding). */
export async function suspendUser(userId: number): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  const row = await usersRepository.update(userId, { status: 'suspended' });
  if (!row) throw new NotFoundError('User not found');
  return toWireUser(row);
}

/** Permanent offboarding path — historical records stay attributed to this user forever. Never a hard delete. */
export async function disableUser(userId: number): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  const row = await usersRepository.update(userId, { status: 'disabled' });
  if (!row) throw new NotFoundError('User not found');
  return toWireUser(row);
}

/** Re-activation of a suspended or previously-disabled account — no new account is ever created for a returning employee. */
export async function reactivateUser(userId: number): Promise<WireUser> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  if (user.status !== 'suspended' && user.status !== 'disabled') {
    throw new BusinessError(409, `Cannot reactivate a user with status "${user.status}"`);
  }
  const row = await usersRepository.update(userId, { status: 'active' });
  if (!row) throw new NotFoundError('User not found');
  return toWireUser(row);
}
