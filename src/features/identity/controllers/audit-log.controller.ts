import type { Request, Response } from 'express';
import { ok } from '../../../core/http/response.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import * as auditService from '../services/audit.service.js';
import type { AuditLogQuery } from '../dtos/audit-log-entries.dto.js';

export async function listAuditLog(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as AuditLogQuery;
  const params = toPaginationParams(query);
  const result = await auditService.listAuditLog({
    ...params,
    ...(query.user_id !== undefined ? { userId: query.user_id } : {}),
    ...(query.target_entity !== undefined ? { targetEntity: query.target_entity } : {}),
  });
  ok(res, result);
}
