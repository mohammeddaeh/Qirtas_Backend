import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { requireActorId, buildActorContext } from '../../../core/http/require-actor.js';
import * as assignmentsService from '../services/user-role-assignments.service.js';
import type {
  CreateAssignmentBody,
  TransferAssignmentBody,
  EndAssignmentBody,
} from '../dtos/user-role-assignments.dto.js';

export async function listForUser(req: Request, res: Response): Promise<void> {
  const { userId } = req.params as unknown as { userId: number };
  const result = await assignmentsService.listActiveForUser(userId);
  ok(res, result);
}

export async function listEndedForUser(req: Request, res: Response): Promise<void> {
  const { userId } = req.params as unknown as { userId: number };
  const result = await assignmentsService.listEndedForUser(userId);
  ok(res, result);
}

export async function createAssignment(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { userId } = req.params as unknown as { userId: number };
  const body = req.body as CreateAssignmentBody;
  const assignment = await assignmentsService.createAssignment(actor, userId, body);
  created(res, assignment);
}

export async function transferAssignment(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { assignmentId } = req.params as unknown as { assignmentId: number };
  const body = req.body as TransferAssignmentBody;
  const assignment = await assignmentsService.transferAssignment(actor, assignmentId, body);
  ok(res, assignment);
}

export async function endAssignment(req: Request, res: Response): Promise<void> {
  const actor = buildActorContext(req, requireActorId(req));
  const { assignmentId } = req.params as unknown as { assignmentId: number };
  const body = (req.body ?? {}) as EndAssignmentBody;
  const assignment = await assignmentsService.endAssignment(
    actor,
    assignmentId,
    body.effective_at ?? new Date(),
    body.force === true,
  );
  ok(res, assignment);
}
