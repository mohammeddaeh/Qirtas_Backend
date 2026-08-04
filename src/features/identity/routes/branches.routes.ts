import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requireAuth } from '../../../core/http/require-actor.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import {
  branchIdParamsSchema,
  createBranchBodySchema,
  updateBranchBodySchema,
  branchesFilterQuerySchema,
} from '../dtos/branches.dto.js';
import * as branchesController from '../controllers/branches.controller.js';

export const branchesRouter = Router();

const listBranchesQuerySchema = paginationQuerySchema.merge(branchesFilterQuerySchema);

branchesRouter.get(
  '/',
  requireAuth,
  validate(listBranchesQuerySchema, 'query'),
  asyncHandler(branchesController.listBranches),
);

branchesRouter.get(
  '/:id',
  requireAuth,
  validate(branchIdParamsSchema, 'params'),
  asyncHandler(branchesController.getBranchById),
);

// Guarded by `users.manage`, not `branches.manage`: the payload is a list of
// people (names, emails, account status). Reading a branch's record and reading
// its roster are different privileges, and the roster follows the data it
// exposes — the same boundary the dashboard's `structure` block draws.
branchesRouter.get(
  '/:id/staff',
  requirePermission('users.manage'),
  validate(branchIdParamsSchema, 'params'),
  validate(paginationQuerySchema, 'query'),
  asyncHandler(branchesController.listBranchStaff),
);

branchesRouter.post(
  '/',
  requirePermission('branches.manage'),
  validate(createBranchBodySchema, 'body'),
  asyncHandler(branchesController.createBranch),
);

branchesRouter.patch(
  '/:id',
  requirePermission('branches.manage'),
  validate(branchIdParamsSchema, 'params'),
  validate(updateBranchBodySchema, 'body'),
  asyncHandler(branchesController.updateBranch),
);
