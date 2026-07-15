import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { createPermissionBodySchema } from '../dtos/permissions.dto.js';
import * as permissionsController from '../controllers/permissions.controller.js';

export const permissionsRouter = Router();

permissionsRouter.get('/', asyncHandler(permissionsController.listPermissions));

permissionsRouter.post(
  '/',
  validate(createPermissionBodySchema, 'body'),
  asyncHandler(permissionsController.createPermission),
);
