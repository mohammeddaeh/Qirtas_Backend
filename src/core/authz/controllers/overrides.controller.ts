import type { Request, Response } from 'express';
import { ok } from '../../http/response.js';
import { requireActorId } from '../../http/require-actor.js';
import * as assignmentsRepository from '../../../features/identity/repositories/user-role-assignments.repository.js';
import * as overridesService from '../services/overrides.service.js';
import type { ReplaceOverridesBody } from '../dtos/overrides.dto.js';

/**
 * Reaches into a feature repository for the role grants, the same
 * composition-root-style exception `core/middleware/auth.ts` and
 * `core/http/require-permission.ts` already take. The alternative — a second
 * port for one query — would be more indirection than the coupling it removes.
 *
 * ⚠️ **The grants passed in are already resolved** (they come from
 * `findAllEffectivePermissionKeys`, which applies the rules). They are handed
 * to the service only so the response can show the outcome beside the choices.
 */

export async function getUserOverrides(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const effective = await assignmentsRepository.findAllEffectivePermissionKeys(id);
  ok(res, await overridesService.getForUser(id, effective));
}

export async function replaceUserOverrides(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const { overrides } = req.body as ReplaceOverridesBody;

  await overridesService.replaceForUser(requireActorId(req), id, overrides);

  // Re-read rather than echo the request: the response must show what the
  // account can now do, which is the resolution of the new rows — not the rows
  // themselves.
  const effective = await assignmentsRepository.findAllEffectivePermissionKeys(id);
  ok(res, await overridesService.getForUser(id, effective), 'Overrides updated');
}
