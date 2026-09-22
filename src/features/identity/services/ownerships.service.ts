import { NotFoundError, BusinessError } from '../../../core/http/api-error.js';
import * as ownershipsRepository from '../repositories/ownerships.repository.js';
import * as usersRepository from '../repositories/users.repository.js';
import * as auditService from './audit.service.js';
import { AUDIT, target } from './audit-actions.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import {
  toWireOwnership,
  type WireOwnership,
  type CreateOwnershipBody,
} from '../dtos/ownerships.dto.js';

const MAX_TOTAL_PERCENTAGE = 100;

/**
 * Strict cap: any save that would push the active-percentage sum for a scope
 * past 100 is rejected outright at write time — no soft warning
 * (users_roles.md, 2026-07-09). Historical (closed, valid_to in the past)
 * records never count toward the sum.
 */
async function assertWithinCap(
  branchScope: number | null,
  incomingPercentage: number,
): Promise<void> {
  const currentSum = await ownershipsRepository.sumActivePercentage(branchScope);
  if (currentSum + incomingPercentage > MAX_TOTAL_PERCENTAGE) {
    throw new BusinessError(
      422,
      `Ownership percentage sum for this scope would be ${currentSum + incomingPercentage}%, exceeding the 100% cap (currently ${currentSum}%).`,

      'ownership_sum_exceeded',
    );
  }
}

function wire(r: ownershipsRepository.OwnershipWithNamesRow): WireOwnership {
  return toWireOwnership(r.row, { user_name: r.user_name, branch_name: r.branch_name });
}

/** Every active record, or one branch's. The client sums per scope from this — the same rows the 100% cap is enforced on. */
export async function listActive(branchScope?: number): Promise<WireOwnership[]> {
  return (await ownershipsRepository.findActiveWithNames(branchScope)).map(wire);
}

export async function createOwnership(
  actor: RequestActorContext,
  body: CreateOwnershipBody,
): Promise<WireOwnership> {
  const user = await usersRepository.findById(body.user_id);
  if (!user) throw new NotFoundError('User not found');

  const branchScope = body.branch_scope ?? null;
  await assertWithinCap(branchScope, body.percentage);

  const row = await ownershipsRepository.insert({
    user_id: body.user_id,
    percentage: body.percentage.toFixed(2),
    branch_scope: branchScope,
  });
  await auditService.record(actor, AUDIT.ownershipCreate, target.ownership(row.id), undefined, {
    user_id: row.user_id,
    percentage: body.percentage,
    branch_scope: branchScope,
  });
  return wireById(row.id);
}

async function wireById(id: number): Promise<WireOwnership> {
  const r = await ownershipsRepository.findWithNamesById(id);
  if (!r) throw new NotFoundError('Ownership record not found');
  return wire(r);
}

/**
 * A share changes size by **closing the old record and opening a new one** —
 * never by editing the number in place, so "who owned what on 1 March" stays
 * answerable (users_roles.md, Ownership edge case).
 */
export async function reviseOwnership(
  actor: RequestActorContext,
  ownershipId: number,
  newPercentage: number,
  effectiveAt: Date = new Date(),
): Promise<WireOwnership> {
  const current = await ownershipsRepository.findById(ownershipId);
  if (!current || (current.valid_to !== null && current.valid_to <= effectiveAt)) {
    throw new NotFoundError('Active ownership record not found');
  }

  // Exclude the record being revised from the sum — it's being replaced, not added on top of.
  const currentSum = await ownershipsRepository.sumActivePercentage(
    current.branch_scope,
    ownershipId,
  );
  if (currentSum + newPercentage > MAX_TOTAL_PERCENTAGE) {
    throw new BusinessError(
      422,
      `Ownership percentage sum for this scope would be ${currentSum + newPercentage}%, exceeding the 100% cap (currently ${currentSum}%, excluding this record).`,
      'ownership_sum_exceeded',
    );
  }

  await ownershipsRepository.closeOwnership(ownershipId, effectiveAt);
  const row = await ownershipsRepository.insert({
    user_id: current.user_id,
    percentage: newPercentage.toFixed(2),
    branch_scope: current.branch_scope,
    valid_from: effectiveAt,
  });
  await auditService.record(
    actor,
    AUDIT.ownershipRevise,
    target.ownership(row.id),
    { percentage: Number(current.percentage), replaced: ownershipId },
    { percentage: newPercentage },
  );
  return wireById(row.id);
}

/** Closes a share (sold, withdrawn). The record stays as history; the scope's total drops by its percentage. */
export async function endOwnership(
  actor: RequestActorContext,
  ownershipId: number,
): Promise<void> {
  const current = await ownershipsRepository.findById(ownershipId);
  const now = new Date();
  if (!current || (current.valid_to !== null && current.valid_to <= now)) {
    throw new NotFoundError('Active ownership record not found');
  }
  await ownershipsRepository.closeOwnership(ownershipId, now);
  await auditService.record(
    actor,
    AUDIT.ownershipEnd,
    target.ownership(ownershipId),
    { percentage: Number(current.percentage), branch_scope: current.branch_scope },
    undefined,
  );
}
