import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { requireActorId } from '../../../core/http/require-actor.js';
import * as assignmentsService from '../services/user-role-assignments.service.js';
import type {
  CreateAssignmentBody,
  TransferAssignmentBody,
} from '../dtos/user-role-assignments.dto.js';

export async function listForUser(req: Request, res: Response): Promise<void> {
  const { userId } = req.params as unknown as { userId: number };
  const result = await assignmentsService.listActiveForUser(userId);
  ok(res, result);
}

export async function createAssignment(req: Request, res: Response): Promise<void> {
  const actorUserId = requireActorId(req);
  const { userId } = req.params as unknown as { userId: number };
  const body = req.body as CreateAssignmentBody;
  const assignment = await assignmentsService.createAssignment(actorUserId, userId, body);
  created(res, assignment);
}

export async function transferAssignment(req: Request, res: Response): Promise<void> {
  const actorUserId = requireActorId(req);
  const { assignmentId } = req.params as unknown as { assignmentId: number };
  const body = req.body as TransferAssignmentBody;
  const assignment = await assignmentsService.transferAssignment(actorUserId, assignmentId, body);
  ok(res, assignment);
}

export async function endAssignment(req: Request, res: Response): Promise<void> {
  const { assignmentId } = req.params as unknown as { assignmentId: number };
  const assignment = await assignmentsService.endAssignment(assignmentId);
  ok(res, assignment);
}
