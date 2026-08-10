import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import {
  roleIdParamsSchema,
  createRoleBodySchema,
  updateRoleBodySchema,
  updateRolePermissionsBodySchema,
  updateRoleLevelBodySchema,
  rolesFilterQuerySchema,
} from '../dtos/roles.dto.js';
import * as rolesController from '../controllers/roles.controller.js';

export const rolesRouter = Router();

const listRolesQuerySchema = paginationQuerySchema.merge(rolesFilterQuerySchema);

rolesRouter.get(
  '/',
  requirePermission('roles.view'),
  validate(listRolesQuerySchema, 'query'),
  asyncHandler(rolesController.listRoles),
);

rolesRouter.get(
  '/:id',
  requirePermission('roles.view'),
  validate(roleIdParamsSchema, 'params'),
  asyncHandler(rolesController.getRoleById),
);

rolesRouter.post(
  '/',
  requirePermission('roles.edit'),
  validate(createRoleBodySchema, 'body'),
  asyncHandler(rolesController.createRole),
);

rolesRouter.patch(
  '/:id',
  requirePermission('roles.edit'),
  validate(roleIdParamsSchema, 'params'),
  validate(updateRoleBodySchema, 'body'),
  asyncHandler(rolesController.updateRole),
);

rolesRouter.put(
  '/:id/permissions',
  requirePermission('roles.edit'),
  validate(roleIdParamsSchema, 'params'),
  validate(updateRolePermissionsBodySchema, 'body'),
  asyncHandler(rolesController.updateRolePermissions),
);

rolesRouter.put(
  '/:id/level',
  requirePermission('roles.edit'),
  validate(roleIdParamsSchema, 'params'),
  validate(updateRoleLevelBodySchema, 'body'),
  asyncHandler(rolesController.updateRoleLevel),
);

// `users.manage`, not `roles.view`: the payload is a list of people (names,
// emails, account status). Reading a role and reading who holds it are
// different privileges, and the endpoint follows the data it exposes — the same
// boundary `GET /branches/:id/staff` draws.
rolesRouter.get(
  '/:id/holders',
  requirePermission('users.manage'),
  validate(roleIdParamsSchema, 'params'),
  validate(paginationQuerySchema, 'query'),
  asyncHandler(rolesController.listRoleHolders),
);

rolesRouter.delete(
  '/:id',
  requirePermission('roles.edit'),
  validate(roleIdParamsSchema, 'params'),
  asyncHandler(rolesController.deleteRole),
);

rolesRouter.post(
  '/:id/deactivate',
  requirePermission('roles.edit'),
  validate(roleIdParamsSchema, 'params'),
  asyncHandler(rolesController.deactivateRole),
);

rolesRouter.post(
  '/:id/reactivate',
  requirePermission('roles.edit'),
  validate(roleIdParamsSchema, 'params'),
  asyncHandler(rolesController.reactivateRole),
);
