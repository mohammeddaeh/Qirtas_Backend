import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { createOwnershipBodySchema, listOwnershipsQuerySchema } from '../dtos/ownerships.dto.js';
import * as ownershipsController from '../controllers/ownerships.controller.js';

export const ownershipsRouter = Router();

ownershipsRouter.get(
  '/',
  validate(listOwnershipsQuerySchema, 'query'),
  asyncHandler(ownershipsController.listByScope),
);

ownershipsRouter.post(
  '/',
  validate(createOwnershipBodySchema, 'body'),
  asyncHandler(ownershipsController.createOwnership),
);
