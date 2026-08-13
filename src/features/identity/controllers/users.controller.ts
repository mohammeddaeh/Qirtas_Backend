import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import { requireActorId, buildActorContext } from '../../../core/http/require-actor.js';
import { resetLoginRateLimit } from '../../../core/middleware/login-rate-limit.js';
import type * as authService from '../../../core/auth/services/auth.service.js';
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

/** Request metadata every delegating call carries — for security events and email language, never for a decision. */
function originOf(req: Request): authService.RequestOrigin {
  return {
    ipAddress: req.ip ?? null,
    deviceInfo: req.header('User-Agent') ?? null,
    lang: req.lang,
  };
}

export async function registerStaff(req: Request, res: Response): Promise<void> {
  const body = req.body as RegisterStaffBody;
  // Carries a session, so the client can go straight to the step this message
  // names instead of asking for the credentials it was just given.
  const result = await usersService.registerStaff(body, originOf(req));
  // The message names the NEXT step, and which step that is depends on whether
  // this deployment verifies addresses — telling someone to await approval when
  // the review queue has not seen their request yet is the kind of
  // accurate-sounding wrong that produces a support ticket a week later.
  created(
    res,
    result,
    result.user.status === 'pending_verification'
      ? 'Registration received — confirm your email address to continue'
      : 'Registration submitted — pending admin approval',
  );
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
  const result = await usersService.login(body, originOf(req));
  // Only on success, and only after it: clearing the counter is what keeps a
  // legitimate user from being punished by their own earlier typos, and doing
  // it before the attempt is judged would clear it for failures too.
  resetLoginRateLimit(body.email, req.ip ?? 'unknown');
  ok(res, result);
}

export async function logout(req: Request, res: Response): Promise<void> {
  const header = req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (token) await usersService.logout(token, originOf(req));
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
//
// MOVED to `features/auth` (2026-08-11). These three are re-exported aliases,
// not copies: they ARE the new handlers, so the deprecated `/users/*` routes
// and the current `/auth/*` routes cannot drift apart — there is one
// implementation with two mount points.
//
// Kept only so the already-shipped mobile client keeps working across the
// deploy. Remove once no released client calls `/users/*` for these.

export {
  forgotPassword,
  resetPassword,
  changePassword,
} from '../../auth/controllers/auth.controller.js';
