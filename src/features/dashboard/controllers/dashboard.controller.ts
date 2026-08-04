import type { Request, Response } from 'express';
import { ok } from '../../../core/http/response.js';
import { requireActorId } from '../../../core/http/require-actor.js';
import * as userRoleAssignmentsRepository from '../../identity/repositories/user-role-assignments.repository.js';
import * as dashboardService from '../services/dashboard.service.js';

export async function getDashboardStats(req: Request, res: Response): Promise<void> {
  const actorUserId = requireActorId(req);
  const permissionKeys = await userRoleAssignmentsRepository.findAllEffectivePermissionKeys(actorUserId);
  const stats = await dashboardService.getDashboardStats(permissionKeys);
  ok(res, stats);
}
