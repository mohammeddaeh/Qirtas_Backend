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
