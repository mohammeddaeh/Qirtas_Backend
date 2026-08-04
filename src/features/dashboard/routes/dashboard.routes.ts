import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import * as dashboardController from '../controllers/dashboard.controller.js';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  requirePermission('dashboard.view'),
  asyncHandler(dashboardController.getDashboardStats),
);
