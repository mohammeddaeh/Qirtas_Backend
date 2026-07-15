import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import * as permissionsService from '../services/permissions.service.js';
import type { CreatePermissionBody } from '../dtos/permissions.dto.js';

export async function listPermissions(_req: Request, res: Response): Promise<void> {
  const result = await permissionsService.listPermissions();
  ok(res, result);
}

export async function createPermission(req: Request, res: Response): Promise<void> {
  const body = req.body as CreatePermissionBody;
  const permission = await permissionsService.createPermission(body);
  created(res, permission);
}
