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

/**
 * The caller's **own** posts — where they work and under which role.
 *
 * A separate route from `/users/:userId/role-assignments`, needing no
 * permission, for exactly the reason `GET /users/me` needs none: reading your
 * own record is not an administrative act. Reading *somebody else's* is, and
 * that is what `users.access` guards.
 *
 * Without it, the profile screen — which every account opens — called the
 * administrative route for its own user id and was answered **403 to anyone
 * without `users.access`**. A person was refused sight of their own job.
 */
export async function listForMe(req: Request, res: Response): Promise<void> {
  const result = await assignmentsService.listActiveForUser(requireActorId(req));
  ok(res, result);
}

/** The caller's own closed postings. Same principle as [listForMe]. */
export async function listEndedForMe(req: Request, res: Response): Promise<void> {
  const result = await assignmentsService.listEndedForUser(requireActorId(req));
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
