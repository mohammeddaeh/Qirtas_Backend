import { NotFoundError, BusinessError } from '../../../core/http/api-error.js';
import * as ownershipsRepository from '../repositories/ownerships.repository.js';
import * as usersRepository from '../repositories/users.repository.js';
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
    );
  }
}

export async function listActiveByScope(branchScope: number | null): Promise<WireOwnership[]> {
  const rows = await ownershipsRepository.findActiveByScope(branchScope);
  return rows.map(toWireOwnership);
}

export async function createOwnership(body: CreateOwnershipBody): Promise<WireOwnership> {
  const user = await usersRepository.findById(body.user_id);
  if (!user) throw new NotFoundError('User not found');

  const branchScope = body.branch_scope ?? null;
  await assertWithinCap(branchScope, body.percentage);

  const row = await ownershipsRepository.insert({
    user_id: body.user_id,
    percentage: body.percentage.toFixed(2),
    branch_scope: branchScope,
  });
  return toWireOwnership(row);
}

/** Percentage changes close the old record and open a new one — same historical pattern as branch transfers. */
export async function reviseOwnership(
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
    );
  }

  await ownershipsRepository.closeOwnership(ownershipId, effectiveAt);
  const row = await ownershipsRepository.insert({
    user_id: current.user_id,
    percentage: newPercentage.toFixed(2),
    branch_scope: current.branch_scope,
    valid_from: effectiveAt,
  });
  return toWireOwnership(row);
}
