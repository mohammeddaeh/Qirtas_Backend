import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import {
  branchIdParamsSchema,
  createBranchBodySchema,
  updateBranchBodySchema,
} from '../dtos/branches.dto.js';
import * as branchesController from '../controllers/branches.controller.js';

export const branchesRouter = Router();

branchesRouter.get(
  '/',
  validate(paginationQuerySchema, 'query'),
  asyncHandler(branchesController.listBranches),
);

branchesRouter.get(
  '/:id',
  validate(branchIdParamsSchema, 'params'),
  asyncHandler(branchesController.getBranchById),
);

branchesRouter.post(
  '/',
  validate(createBranchBodySchema, 'body'),
  asyncHandler(branchesController.createBranch),
);

branchesRouter.patch(
  '/:id',
  validate(branchIdParamsSchema, 'params'),
  validate(updateBranchBodySchema, 'body'),
  asyncHandler(branchesController.updateBranch),
);
