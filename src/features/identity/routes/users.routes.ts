import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requireAuth } from '../../../core/http/require-actor.js';
import { publicRoute } from '../../../core/http/route-marker.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { loginRateLimit } from '../../../core/middleware/login-rate-limit.js';
import { passwordResetRateLimit } from '../../../core/middleware/password-reset-rate-limit.js';
import { registerRateLimit } from '../../../core/middleware/register-rate-limit.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import {
  userIdParamsSchema,
  registerStaffBodySchema,
  resubmitRegistrationBodySchema,
  decideRegistrationBodySchema,
  loginBodySchema,
  forgotPasswordBodySchema,
  resetPasswordBodySchema,
  changePasswordBodySchema,
  bootstrapSuperAdminBodySchema,
  updateUserBodySchema,
  createUserByAdminBodySchema,
  usersFilterQuerySchema,
} from '../dtos/users.dto.js';
import * as usersController from '../controllers/users.controller.js';
import { userRoleAssignmentsRouter } from './user-role-assignments.routes.js';

export const usersRouter = Router();

const listUsersQuerySchema = paginationQuerySchema.merge(usersFilterQuerySchema);

/**
 * `users.manage`, not `requireAuth`: the response is the organisation's whole
 * staff directory — names, emails, account statuses. Hiding the screen in the
 * client is not access control; anyone holding a valid token could read it
 * (production_readiness.md §A1). Reading one's own record stays open via
 * `/me` below, which is what a non-admin actually needs.
 */
usersRouter.get(
  '/',
  requirePermission('users.manage'),
  validate(listUsersQuerySchema, 'query'),
  asyncHandler(usersController.listUsers),
);

/** Any authenticated user reads their own data + current effective permissions — no specific permission required. Registered before /:id so it isn't swallowed by the param route. */
usersRouter.get('/me', requireAuth, asyncHandler(usersController.getCurrentUser));

/** Self-service resubmit after a rejection — only the calling user's own (rejected) account, identified by session, never by :id. Registered before /:id for the same reason as /me above. */
usersRouter.post(
  '/me/resubmit-registration',
  requireAuth,
  validate(resubmitRegistrationBodySchema, 'body'),
  asyncHandler(usersController.resubmitRegistration),
);

/** Another person's record — same boundary as the list above. */
usersRouter.get(
  '/:id',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.getUserById),
);

/**
 * What this person can actually do — the union across their active
 * assignments. `users.manage`, like every other read of someone else's record.
 * Own permissions come from `/users/me`, which needs no permission at all.
 */
usersRouter.get(
  '/:id/permissions',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.getUserPermissions),
);

/**
 * Admin-direct creation — distinct from POST /register (self-service +
 * later decide-registration review). The admin creating the account IS the
 * approval: lands at status=active immediately with role/branch/ownership
 * already assigned in this single call.
 */
usersRouter.post(
  '/',
  requirePermission('users.manage'),
  validate(createUserByAdminBodySchema, 'body'),
  asyncHandler(usersController.createUserByAdmin),
);

/** Edits identity/profile fields only (first_name/last_name/email/phone) — status/is_admin/password stay on their own dedicated endpoints. */
usersRouter.patch(
  '/:id',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  validate(updateUserBodySchema, 'body'),
  asyncHandler(usersController.updateUser),
);

/** Single self-registration entry point for every internal account (staff/partner). */
usersRouter.post(
  '/register',
  publicRoute,
  validate(registerStaffBodySchema, 'body'),
  registerRateLimit,
  asyncHandler(usersController.registerStaff),
);

/** First-run bootstrap — only succeeds while zero User rows exist. */
usersRouter.post(
  '/bootstrap-super-admin',
  publicRoute,
  validate(bootstrapSuperAdminBodySchema, 'body'),
  asyncHandler(usersController.bootstrapSuperAdmin),
);

usersRouter.post(
  '/login',
  publicRoute,
  validate(loginBodySchema, 'body'),
  loginRateLimit,
  asyncHandler(usersController.login),
);

/** Ends only the calling session (identified by its own Bearer token) — other concurrent sessions are untouched. */
usersRouter.post('/logout', publicRoute, asyncHandler(usersController.logout));

// ── Password reset & change — DEPRECATED ALIASES ─────────────────────────────
//
// These three moved to `/api/v1/auth/*` (2026-08-11). They are kept here, with
// identical middleware and the identical handler, purely so the already-shipped
// mobile client keeps working across the deploy.
//
// They are aliases, not copies: `usersController.forgotPassword` and friends
// are re-exports of the `features/auth` handlers, so the two mount points
// cannot drift. Delete this block once no released client calls `/users/*` for
// them.
//
// The first two are UNAUTHENTICATED by definition — the caller cannot sign in.
// That makes the rate limit, together with the per-code attempt ceiling in
// `core/auth/services/verification.service.ts`, the only thing standing between
// them and both a mail cannon and a machine-speed guessing loop.

/** Always succeeds, registered address or not — see core/auth/services/auth.service.ts for why. */
usersRouter.post(
  '/forgot-password',
  publicRoute,
  validate(forgotPasswordBodySchema, 'body'),
  passwordResetRateLimit,
  asyncHandler(usersController.forgotPassword),
);

usersRouter.post(
  '/reset-password',
  publicRoute,
  validate(resetPasswordBodySchema, 'body'),
  passwordResetRateLimit,
  asyncHandler(usersController.resetPassword),
);

/**
 * Authenticated — and needs no `requirePermission`: the actor is changing their
 * OWN password, which is not a privileged action over anyone else.
 *
 * `requireAuth` added with the move. Its absence here was a real gap rather
 * than a shortcut: the handler called `requireActorId(req)` itself, so an
 * anonymous caller did get a 401 — but only after the body had been validated,
 * which meant an unauthenticated request reached password-strength checking.
 * The guard now sits where every other authenticated route puts it.
 */
usersRouter.post(
  '/change-password',
  requireAuth,
  validate(changePasswordBodySchema, 'body'),
  asyncHandler(usersController.changePassword),
);

usersRouter.post(
  '/:id/decide-registration',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  validate(decideRegistrationBodySchema, 'body'),
  asyncHandler(usersController.decideRegistration),
);

usersRouter.post(
  '/:id/suspend',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.suspendUser),
);

usersRouter.post(
  '/:id/disable',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.disableUser),
);

usersRouter.post(
  '/:id/reactivate',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.reactivateUser),
);

// Destroys an account with nothing recorded against it — no assignment, no
// ownership, no audit entry it authored. `users.manage` alone, because with no
// history there is nothing to weigh: this is the mistyped duplicate created ten
// minutes ago, deleted by whoever created it.
usersRouter.delete(
  '/:id',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.deleteUser),
);

// Retiring an account that HAS a past needs `records.archive` on top — the same
// pairing as `/branches/:id/archive`, and here it also hides a person from every
// staffing and review screen, which is not part of running a branch.
usersRouter.post(
  '/:id/archive',
  requirePermission('users.manage'),
  requirePermission('records.archive'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.archiveUser),
);

usersRouter.post(
  '/:id/unarchive',
  requirePermission('users.manage'),
  requirePermission('records.archive'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.unarchiveUser),
);

/** :userId here (not :id) so mergeParams hands the nested router a userId key matching its own DTO schema. */
usersRouter.use('/:userId/role-assignments', userRoleAssignmentsRouter);
