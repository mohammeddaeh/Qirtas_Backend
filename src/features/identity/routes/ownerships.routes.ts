import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requireAuth } from '../../../core/http/require-actor.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { createOwnershipBodySchema, listOwnershipsQuerySchema } from '../dtos/ownerships.dto.js';
import * as ownershipsController from '../controllers/ownerships.controller.js';

export const ownershipsRouter = Router();

ownershipsRouter.get(
  '/',
  requireAuth,
  validate(listOwnershipsQuerySchema, 'query'),
  asyncHandler(ownershipsController.listByScope),
);

ownershipsRouter.post(
  '/',
  requirePermission('ownerships.manage'),
  validate(createOwnershipBodySchema, 'body'),
  asyncHandler(ownershipsController.createOwnership),
);
