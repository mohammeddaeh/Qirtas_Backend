import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import {
  createOwnershipBodySchema,
  listOwnershipsQuerySchema,
  ownershipIdParamsSchema,
  revisePercentageBodySchema,
} from '../dtos/ownerships.dto.js';
import * as ownershipsController from '../controllers/ownerships.controller.js';

/**
 * `/api/v1/ownerships` — who owns which share, and where.
 *
 * Every route needs `ownerships.manage`. The list used to be `requireAuth`
 * alone; it now names people and their percentages, which no ordinary account
 * has any business reading.
 */
export const ownershipsRouter = Router();

/** All active shares (each with names), or one branch's with `?branch_scope=`. */
ownershipsRouter.get(
  '/',
  requirePermission('ownerships.manage'),
  validate(listOwnershipsQuerySchema, 'query'),
  asyncHandler(ownershipsController.list),
);

ownershipsRouter.post(
  '/',
  requirePermission('ownerships.manage'),
  validate(createOwnershipBodySchema, 'body'),
  asyncHandler(ownershipsController.createOwnership),
);

/** Resizes a share: closes this record and opens a new one — history is kept. */
ownershipsRouter.post(
  '/:id/revise',
  requirePermission('ownerships.manage'),
  validate(ownershipIdParamsSchema, 'params'),
  validate(revisePercentageBodySchema, 'body'),
  asyncHandler(ownershipsController.reviseOwnership),
);

/** Closes a share (sold / withdrawn). The record stays as history. */
ownershipsRouter.post(
  '/:id/end',
  requirePermission('ownerships.manage'),
  validate(ownershipIdParamsSchema, 'params'),
  asyncHandler(ownershipsController.endOwnership),
);
