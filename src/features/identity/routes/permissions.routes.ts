import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requireApprovedStaff } from '../../../core/http/require-actor.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { createPermissionBodySchema } from '../dtos/permissions.dto.js';
import * as permissionsController from '../controllers/permissions.controller.js';

export const permissionsRouter = Router();

permissionsRouter.get('/', requireApprovedStaff, asyncHandler(permissionsController.listPermissions));

permissionsRouter.post(
  '/',
  requirePermission('permissions.manage'),
  validate(createPermissionBodySchema, 'body'),
  asyncHandler(permissionsController.createPermission),
);
