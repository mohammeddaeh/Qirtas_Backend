import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import {
  roleIdParamsSchema,
  createRoleBodySchema,
  updateRolePermissionsBodySchema,
  updateRoleLevelBodySchema,
} from '../dtos/roles.dto.js';
import * as rolesController from '../controllers/roles.controller.js';

export const rolesRouter = Router();

rolesRouter.get(
  '/',
  validate(paginationQuerySchema, 'query'),
  asyncHandler(rolesController.listRoles),
);

rolesRouter.get(
  '/:id',
  validate(roleIdParamsSchema, 'params'),
  asyncHandler(rolesController.getRoleById),
);

rolesRouter.post(
  '/',
  validate(createRoleBodySchema, 'body'),
  asyncHandler(rolesController.createRole),
);

rolesRouter.put(
  '/:id/permissions',
  validate(roleIdParamsSchema, 'params'),
  validate(updateRolePermissionsBodySchema, 'body'),
  asyncHandler(rolesController.updateRolePermissions),
);

rolesRouter.put(
  '/:id/level',
  validate(roleIdParamsSchema, 'params'),
  validate(updateRoleLevelBodySchema, 'body'),
  asyncHandler(rolesController.updateRoleLevel),
);

rolesRouter.post(
  '/:id/deactivate',
  validate(roleIdParamsSchema, 'params'),
  asyncHandler(rolesController.deactivateRole),
);
