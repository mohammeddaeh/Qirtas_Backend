import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import {
  userIdParamsSchema,
  assignmentIdParamsSchema,
  createAssignmentBodySchema,
  transferAssignmentBodySchema,
} from '../dtos/user-role-assignments.dto.js';
import * as assignmentsController from '../controllers/user-role-assignments.controller.js';

/** Mounted at /api/v1/users/:userId/role-assignments */
export const userRoleAssignmentsRouter = Router({ mergeParams: true });

/**
 * `users.manage`: this answers "where does this person work and under which
 * role" for ANY user id, which maps the whole organisation one request at a
 * time. Same boundary as GET /users (production_readiness.md §A1).
 */
userRoleAssignmentsRouter.get(
  '/',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(assignmentsController.listForUser),
);

/**
 * The closed half of the same record — separate path rather than a `?ended=true`
 * flag on the list above, because the two are read at different moments and by
 * different screens: the active list is the working answer to "where is this
 * person", the ended list is history someone opens deliberately. Folding them
 * into one response would make every routine load pay for the name
 * reconstruction each ended row needs.
 */
userRoleAssignmentsRouter.get(
  '/ended',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  asyncHandler(assignmentsController.listEndedForUser),
);

userRoleAssignmentsRouter.post(
  '/',
  requirePermission('users.manage'),
  validate(userIdParamsSchema, 'params'),
  validate(createAssignmentBodySchema, 'body'),
  asyncHandler(assignmentsController.createAssignment),
);

/** Mounted at /api/v1/role-assignments */
export const roleAssignmentsRouter = Router();

roleAssignmentsRouter.post(
  '/:assignmentId/transfer',
  requirePermission('users.manage'),
  validate(assignmentIdParamsSchema, 'params'),
  validate(transferAssignmentBodySchema, 'body'),
  asyncHandler(assignmentsController.transferAssignment),
);

roleAssignmentsRouter.post(
  '/:assignmentId/end',
  requirePermission('users.manage'),
  validate(assignmentIdParamsSchema, 'params'),
  asyncHandler(assignmentsController.endAssignment),
);
