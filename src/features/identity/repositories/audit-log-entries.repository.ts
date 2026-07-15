import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated } from '../../../core/db/crud-helpers.js';
import {
  auditLogEntriesTable,
  type AuditLogEntryRow,
  type NewAuditLogEntryRow,
} from '../schemas/audit-log-entries.schema.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';

export async function insert(data: NewAuditLogEntryRow): Promise<AuditLogEntryRow> {
  const rows = await db.insert(auditLogEntriesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export function findMany(
  params: PaginationParams & { userId?: number; targetEntity?: string },
): Promise<{ rows: AuditLogEntryRow[]; total: number }> {
  const conditions = [
    params.userId ? eq(auditLogEntriesTable.user_id, params.userId) : undefined,
    params.targetEntity ? eq(auditLogEntriesTable.target_entity, params.targetEntity) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  return findManyPaginated<AuditLogEntryRow>(auditLogEntriesTable, params, {
    where: whereClause,
    orderBy: desc(auditLogEntriesTable.created_at),
  });
}
