import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import {
  userIdParamsSchema,
  registerStaffBodySchema,
  decideRegistrationBodySchema,
  loginBodySchema,
  bootstrapSuperAdminBodySchema,
} from '../dtos/users.dto.js';
import * as usersController from '../controllers/users.controller.js';
import { userRoleAssignmentsRouter } from './user-role-assignments.routes.js';

export const usersRouter = Router();

usersRouter.get(
  '/',
  validate(paginationQuerySchema, 'query'),
  asyncHandler(usersController.listUsers),
);

usersRouter.get(
  '/:id',
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.getUserById),
);

/** Single self-registration entry point for every internal account (staff/partner). */
usersRouter.post(
  '/register',
  validate(registerStaffBodySchema, 'body'),
  asyncHandler(usersController.registerStaff),
);

/** First-run bootstrap — only succeeds while zero User rows exist. */
usersRouter.post(
  '/bootstrap-super-admin',
  validate(bootstrapSuperAdminBodySchema, 'body'),
  asyncHandler(usersController.bootstrapSuperAdmin),
);

usersRouter.post('/login', validate(loginBodySchema, 'body'), asyncHandler(usersController.login));

usersRouter.post(
  '/:id/decide-registration',
  validate(userIdParamsSchema, 'params'),
  validate(decideRegistrationBodySchema, 'body'),
  asyncHandler(usersController.decideRegistration),
);

usersRouter.post(
  '/:id/suspend',
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.suspendUser),
);

usersRouter.post(
  '/:id/disable',
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.disableUser),
);

usersRouter.post(
  '/:id/reactivate',
  validate(userIdParamsSchema, 'params'),
  asyncHandler(usersController.reactivateUser),
);

/** :userId here (not :id) so mergeParams hands the nested router a userId key matching its own DTO schema. */
usersRouter.use('/:userId/role-assignments', userRoleAssignmentsRouter);
