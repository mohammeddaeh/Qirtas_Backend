import {
  paginated,
  type PaginationParams,
  type Paginated,
} from '../../../core/pagination/pagination.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import * as auditLogRepository from '../repositories/audit-log-entries.repository.js';
import { toWireAuditLogEntry, type WireAuditLogEntry } from '../dtos/audit-log-entries.dto.js';

export type { RequestActorContext };

export async function record(
  actor: RequestActorContext,
  action: string,
  targetEntity: string,
  previousValue: unknown,
  newValue: unknown,
): Promise<void> {
  await auditLogRepository.insert({
    user_id: actor.userId,
    action,
    target_entity: targetEntity,
    previous_value: previousValue === undefined ? null : previousValue,
    new_value: newValue === undefined ? null : newValue,
    ip_address: actor.ipAddress,
    device_info: actor.deviceInfo,
    performed_by_role: actor.performedByRole,
    branch_context: actor.branchContext,
  });
}

export async function listAuditLog(
  params: PaginationParams & { userId?: number; targetEntity?: string },
): Promise<Paginated<WireAuditLogEntry>> {
  const { rows, total } = await auditLogRepository.findMany(params);
  return paginated(rows.map(toWireAuditLogEntry), total, params);
}

/**
 * What [targetEntity] was called at [at] — reconstructed, not stored.
 *
 * A role's rows carry only its name TODAY, so an assignment that ran while the
 * role was called "كاشير" renders as "موظف مبيعات" once someone renames it, and
 * the record silently rewrites its own past. The audit log already holds every
 * rename with both sides and a timestamp, so the answer is derivable: start
 * from the current name and rewind through each rename that happened after
 * [at].
 *
 * Derived rather than snapshotted onto the assignment row on purpose. A stored
 * copy is a second place the name lives, and the two disagree the first time
 * one of them is written and the other is not — the failure this codebase has
 * already paid for elsewhere. The cost is one indexed query per lookup, on an
 * index that exists (`target_created_idx`).
 *
 * Returns [currentName] unchanged when nothing was renamed after [at], which is
 * the overwhelmingly common case.
 */
export async function resolveNameAt(
  targetEntity: string,
  at: Date,
  currentName: string,
): Promise<string> {
  const renames = await auditLogRepository.findRenamesAfter(targetEntity, at);

  let name = currentName;
  // Newest first: each step walks the name one rename further back in time.
  for (const entry of renames) {
    const before = readName(entry.previous_value);
    const after = readName(entry.new_value);
    // Entries that are not renames (a level change, a deactivation) carry no
    // name at all, or the same one on both sides — either way they move nothing.
    if (before === null || after === null || before === after) continue;
    name = before;
  }
  return name;
}

function readName(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const name = (value as Record<string, unknown>).name;
  return typeof name === 'string' ? name : null;
}
