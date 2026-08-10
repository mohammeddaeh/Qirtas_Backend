import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requireAuth } from '../../../core/http/require-actor.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { loginRateLimit } from '../../../core/middleware/login-rate-limit.js';
import { registerRateLimit } from '../../../core/middleware/register-rate-limit.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import {
  userIdParamsSchema,
  registerStaffBodySchema,
  resubmitRegistrationBodySchema,
  decideRegistrationBodySchema,
  loginBodySchema,
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
  validate(registerStaffBodySchema, 'body'),
  registerRateLimit,
  asyncHandler(usersController.registerStaff),
);

/** First-run bootstrap — only succeeds while zero User rows exist. */
usersRouter.post(
  '/bootstrap-super-admin',
  validate(bootstrapSuperAdminBodySchema, 'body'),
  asyncHandler(usersController.bootstrapSuperAdmin),
);

usersRouter.post(
  '/login',
  validate(loginBodySchema, 'body'),
  loginRateLimit,
  asyncHandler(usersController.login),
);

/** Ends only the calling session (identified by its own Bearer token) — other concurrent sessions are untouched. */
usersRouter.post('/logout', asyncHandler(usersController.logout));

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

/** :userId here (not :id) so mergeParams hands the nested router a userId key matching its own DTO schema. */
usersRouter.use('/:userId/role-assignments', userRoleAssignmentsRouter);
