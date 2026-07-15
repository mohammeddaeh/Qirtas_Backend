import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import { requireActorId } from '../../../core/http/require-actor.js';
import * as usersService from '../services/users.service.js';
import type {
  RegisterStaffBody,
  DecideRegistrationBody,
  LoginBody,
  BootstrapSuperAdminBody,
} from '../dtos/users.dto.js';

export async function listUsers(req: Request, res: Response): Promise<void> {
  const params = toPaginationParams(req.query as unknown as { page: number; limit: number });
  const result = await usersService.listUsers(params);
  ok(res, result);
}

export async function getUserById(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const user = await usersService.getUserById(id);
  ok(res, user);
}

export async function registerStaff(req: Request, res: Response): Promise<void> {
  const body = req.body as RegisterStaffBody;
  const user = await usersService.registerStaff(body);
  created(res, user, 'Registration submitted — pending admin approval');
}

export async function decideRegistration(req: Request, res: Response): Promise<void> {
  const actorUserId = requireActorId(req);
  const { id } = req.params as unknown as { id: number };
  const body = req.body as DecideRegistrationBody;
  const user = await usersService.decideRegistration(actorUserId, id, body);
  ok(res, user);
}

export async function bootstrapSuperAdmin(req: Request, res: Response): Promise<void> {
  const body = req.body as BootstrapSuperAdminBody;
  const user = await usersService.bootstrapSuperAdmin(body);
  created(res, user, 'Super Admin account created');
}

export async function login(req: Request, res: Response): Promise<void> {
  const body = req.body as LoginBody;
  const result = await usersService.login(body);
  ok(res, result);
}

export async function suspendUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const user = await usersService.suspendUser(id);
  ok(res, user);
}

export async function disableUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const user = await usersService.disableUser(id);
  ok(res, user);
}

export async function reactivateUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const user = await usersService.reactivateUser(id);
  ok(res, user);
}
