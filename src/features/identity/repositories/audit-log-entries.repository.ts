import { eq, and, desc, sql, gt } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import {
  auditLogEntriesTable,
  type AuditLogEntryRow,
  type NewAuditLogEntryRow,
} from '../schemas/audit-log-entries.schema.js';
import { usersTable } from '../schemas/users.schema.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';

/** An entry joined to the person who performed it. */
export interface AuditLogEntryWithActorRow extends AuditLogEntryRow {
  performed_by_name: string | null;
}

export async function insert(data: NewAuditLogEntryRow): Promise<AuditLogEntryRow> {
  const rows = await db.insert(auditLogEntriesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

/**
 * How many entries this person is the actor of — the hard floor under user
 * deletion.
 *
 * `user_id` is `RESTRICT`, and deliberately so: an audit trail whose actor
 * column could be emptied by deleting the actor is not an audit trail. The
 * practical consequence is that anyone who has ever performed a recorded action
 * — including their own sign-in — can never be hard-deleted, no matter how
 * empty their assignment history looks. `deleteUser` checks this so the refusal
 * arrives as a sentence naming the reason, and points at archiving instead,
 * rather than surfacing as a foreign-key error from the driver.
 */
export async function countByActor(userId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(auditLogEntriesTable)
    .where(eq(auditLogEntriesTable.user_id, userId));
  return Number(rows[0]?.value ?? 0);
}

/**
 * The actor is joined rather than resolved by the caller for the same reason
 * assignments join their role name: "user 3 renamed this" is not a sentence a
 * reader can use, and fetching the user catalogue to label a page of entries
 * costs more than the join.
 */
export async function findMany(
  params: PaginationParams & { userId?: number; targetEntity?: string },
): Promise<{ rows: AuditLogEntryWithActorRow[]; total: number }> {
  const conditions = [
    params.userId ? eq(auditLogEntriesTable.user_id, params.userId) : undefined,
    params.targetEntity ? eq(auditLogEntriesTable.target_entity, params.targetEntity) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const base = db
    .select({
      id: auditLogEntriesTable.id,
      user_id: auditLogEntriesTable.user_id,
      action: auditLogEntriesTable.action,
      target_entity: auditLogEntriesTable.target_entity,
      previous_value: auditLogEntriesTable.previous_value,
      new_value: auditLogEntriesTable.new_value,
      ip_address: auditLogEntriesTable.ip_address,
      device_info: auditLogEntriesTable.device_info,
      performed_by_role: auditLogEntriesTable.performed_by_role,
      branch_context: auditLogEntriesTable.branch_context,
      created_at: auditLogEntriesTable.created_at,
      performed_by_name:
        sql<string | null>`${usersTable.first_name} || ' ' || ${usersTable.last_name}`.as(
          'performed_by_name',
        ),
    })
    .from(auditLogEntriesTable)
    .leftJoin(usersTable, eq(usersTable.id, auditLogEntriesTable.user_id));

  const rows = await (whereClause ? base.where(whereClause) : base)
    .orderBy(desc(auditLogEntriesTable.created_at))
    .limit(params.limit)
    .offset(params.offset);

  const countBase = db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogEntriesTable);
  const countRows = await (whereClause ? countBase.where(whereClause) : countBase);

  return { rows, total: countRows[0]?.count ?? 0 };
}

/**
 * Every rename of [targetEntity] that happened AFTER [at], newest first.
 *
 * The basis for answering "what was this called back then": the current name is
 * known, and each of these entries rewinds it one step. Deliberately not a
 * `role.*` query — the shape (`previous_value.name` → `new_value.name`) is the
 * same for a branch or anything else that carries a name, so the resolver built
 * on it works for all of them.
 */
export async function findRenamesAfter(
  targetEntity: string,
  at: Date,
): Promise<Array<{ previous_value: unknown; new_value: unknown; created_at: Date }>> {
  return db
    .select({
      previous_value: auditLogEntriesTable.previous_value,
      new_value: auditLogEntriesTable.new_value,
      created_at: auditLogEntriesTable.created_at,
    })
    .from(auditLogEntriesTable)
    .where(
      and(
        eq(auditLogEntriesTable.target_entity, targetEntity),
        gt(auditLogEntriesTable.created_at, at),
      ),
    )
    .orderBy(desc(auditLogEntriesTable.created_at));
}
