import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requireAuth } from '../../../core/http/require-actor.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { publicRoute } from '../../../core/http/route-marker.js';
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

// Public — the ONLY unauthenticated route on this router, and the twin of
// `GET /roles/self-registerable`. Registration happens before an account
// exists, so the visitor has no session to read `GET /` with, yet the form asks
// which branch they work at.
//
// ⚠️ Must stay ABOVE `/:id`: Express matches in mount order, and `/:id` would
// otherwise swallow this path and reject it as a non-numeric id.
branchesRouter.get(
  '/self-registerable',
  publicRoute,
  asyncHandler(branchesController.listSelfRegisterableBranches),
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
  requirePermission('users.view'),
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

// Destroys a branch nothing has ever pointed at. Guarded by `branches.manage`
// alone — there is nothing to weigh when nothing references the row, so it
// answers to the same permission that created it a minute earlier.
branchesRouter.delete(
  '/:id',
  requirePermission('branches.manage'),
  validate(branchIdParamsSchema, 'params'),
  asyncHandler(branchesController.deleteBranch),
);

// Retiring a branch that HAS a past needs BOTH permissions, and the second is
// the point: `branches.manage` belongs to whoever runs branches, while deciding
// that a place people worked in should stop appearing anywhere is a different
// call. Two middlewares rather than one combined key so the everyday half stays
// the same everyday key.
branchesRouter.post(
  '/:id/archive',
  requirePermission('branches.manage'),
  requirePermission('records.archive'),
  validate(branchIdParamsSchema, 'params'),
  asyncHandler(branchesController.archiveBranch),
);

branchesRouter.post(
  '/:id/unarchive',
  requirePermission('branches.manage'),
  requirePermission('records.archive'),
  validate(branchIdParamsSchema, 'params'),
  asyncHandler(branchesController.unarchiveBranch),
);
