import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import {
  userIdParamsSchema,
  assignmentIdParamsSchema,
  createAssignmentBodySchema,
  transferAssignmentBodySchema,
} from '../dtos/user-role-assignments.dto.js';
import * as assignmentsController from '../controllers/user-role-assignments.controller.js';

/** Mounted at /api/v1/users/:userId/role-assignments */
export const userRoleAssignmentsRouter = Router({ mergeParams: true });

userRoleAssignmentsRouter.get(
  '/',
  validate(userIdParamsSchema, 'params'),
  asyncHandler(assignmentsController.listForUser),
);

userRoleAssignmentsRouter.post(
  '/',
  validate(userIdParamsSchema, 'params'),
  validate(createAssignmentBodySchema, 'body'),
  asyncHandler(assignmentsController.createAssignment),
);

/** Mounted at /api/v1/role-assignments */
export const roleAssignmentsRouter = Router();

roleAssignmentsRouter.post(
  '/:assignmentId/transfer',
  validate(assignmentIdParamsSchema, 'params'),
  validate(transferAssignmentBodySchema, 'body'),
  asyncHandler(assignmentsController.transferAssignment),
);

roleAssignmentsRouter.post(
  '/:assignmentId/end',
  validate(assignmentIdParamsSchema, 'params'),
  asyncHandler(assignmentsController.endAssignment),
);
