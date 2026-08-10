import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import { requireActorId, buildActorContext } from '../../../core/http/require-actor.js';
import { resetLoginRateLimit } from '../../../core/middleware/login-rate-limit.js';
import * as usersService from '../services/users.service.js';
import type {
  RegisterStaffBody,
  DecideRegistrationBody,
  LoginBody,
  BootstrapSuperAdminBody,
  UpdateUserBody,
  CreateUserByAdminBody,
  UsersFilterQuery,
  ResubmitRegistrationBody,
  ForgotPasswordBody,
  ResetPasswordBody,
  ChangePasswordBody,
} from '../dtos/users.dto.js';

export async function listUsers(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { page: number; limit: number } & UsersFilterQuery;
  const params = toPaginationParams(query);
  const result = await usersService.listUsers(params, query);
  ok(res, result);
}

export async function getUserById(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const user = await usersService.getUserById(id);
  ok(res, user);
}

/** Returns the calling user's own data + current effective permission keys — same shape as login()'s data, minus token/session_id. */
export async function getCurrentUser(req: Request, res: Response): Promise<void> {
  const actorUserId = requireActorId(req);
  const result = await usersService.getCurrentUser(actorUserId);
  ok(res, result);
}

export async function getUserPermissions(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  ok(res, await usersService.getUserPermissions(id));
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  const body = req.body as UpdateUserBody;
  const user = await usersService.updateUser(actor, id, body);
  ok(res, user);
}

export async function createUserByAdmin(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const body = req.body as CreateUserByAdminBody;
  const user = await usersService.createUserByAdmin(actor, body);
  created(res, user);
}

export async function registerStaff(req: Request, res: Response): Promise<void> {
  const body = req.body as RegisterStaffBody;
  const user = await usersService.registerStaff(body);
  created(res, user, 'Registration submitted — pending admin approval');
}

export async function resubmitRegistration(req: Request, res: Response): Promise<void> {
  const actorUserId = requireActorId(req);
  const body = req.body as ResubmitRegistrationBody;
  const user = await usersService.resubmitRegistration(actorUserId, body);
  ok(res, user);
}

export async function decideRegistration(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  const body = req.body as DecideRegistrationBody;
  const user = await usersService.decideRegistration(actor, id, body);
  ok(res, user);
}

export async function bootstrapSuperAdmin(req: Request, res: Response): Promise<void> {
  const body = req.body as BootstrapSuperAdminBody;
  const user = await usersService.bootstrapSuperAdmin(body);
  created(res, user, 'Super Admin account created');
}

export async function login(req: Request, res: Response): Promise<void> {
  const body = req.body as LoginBody;
  const result = await usersService.login(body);
  resetLoginRateLimit(body.email, req.ip ?? 'unknown');
  ok(res, result);
}

export async function logout(req: Request, res: Response): Promise<void> {
  const header = req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (token) await usersService.logout(token);
  ok(res, null);
}

export async function suspendUser(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  const user = await usersService.suspendUser(actor, id);
  ok(res, user);
}

export async function disableUser(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  const user = await usersService.disableUser(actor, id);
  ok(res, user);
}

export async function reactivateUser(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  const user = await usersService.reactivateUser(actor, id);
  ok(res, user);
}

// ── Password reset & change ──────────────────────────────────────────────────

/**
 * Answers 200 whether or not the address is registered — see
 * `usersService.requestPasswordReset` for why that is the contract and not an
 * oversight. Do not add a "user not found" branch here.
 */
export async function forgotPassword(req: Request, res: Response): Promise<void> {
  await usersService.requestPasswordReset(req.body as ForgotPasswordBody);
  ok(res, null);
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await usersService.resetPassword(req.body as ResetPasswordBody);
  ok(res, null);
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const actorUserId = requireActorId(req);
  await usersService.changePassword(actorUserId, req.body as ChangePasswordBody);
  ok(res, null);
}
