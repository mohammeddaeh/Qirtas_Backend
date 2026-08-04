import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { auditLogQuerySchema } from '../dtos/audit-log-entries.dto.js';
import * as auditLogController from '../controllers/audit-log.controller.js';

export const auditLogRouter = Router();

auditLogRouter.get(
  '/',
  requirePermission('audit_log.view'),
  validate(auditLogQuerySchema, 'query'),
  asyncHandler(auditLogController.listAuditLog),
);
