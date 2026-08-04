import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import { requireActorId, buildActorContext } from '../../../core/http/require-actor.js';
import * as rolesService from '../services/roles.service.js';
import type {
  CreateRoleBody,
  UpdateRolePermissionsBody,
  UpdateRoleLevelBody,
  RolesFilterQuery,
} from '../dtos/roles.dto.js';

export async function listRoles(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { page: number; limit: number } & RolesFilterQuery;
  const params = toPaginationParams(query);
  // The actor is needed only for `?assignable=true`, which is relative to
  // whoever is asking.
  const result = await rolesService.listRoles(params, query, requireActorId(req));
  ok(res, result);
}

export async function getRoleById(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const role = await rolesService.getRoleById(id);
  ok(res, role);
}

export async function createRole(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const body = req.body as CreateRoleBody;
  const role = await rolesService.createRole(actor, body);
  const overSoftCap = await rolesService.isOverSoftCap();
  created(
    res,
    role,
    overSoftCap
      ? 'Created. Note: the number of active roles is getting large — consider reviewing and consolidating similar roles.'
      : 'Created',
  );
}

export async function updateRolePermissions(req: Request, res: Response): Promise<void> {
  const actorUserId = requireActorId(req);
  const { id } = req.params as unknown as { id: number };
  const body = req.body as UpdateRolePermissionsBody;
  const role = await rolesService.updateRolePermissions(
    buildActorContext(req, actorUserId),
    id,
    body,
  );
  ok(res, role);
}

export async function updateRoleLevel(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  const body = req.body as UpdateRoleLevelBody;
  const role = await rolesService.updateRoleLevel(actor, id, body.level);
  ok(res, role);
}

export async function deactivateRole(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { id } = req.params as unknown as { id: number };
  const role = await rolesService.deactivateRole(actor, id);
  ok(res, role);
}
