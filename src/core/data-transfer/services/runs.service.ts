import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { logger } from '../../logger/logger.js';
import { usersTable } from '../../../features/identity/schemas/users.schema.js';
import { stationsTable } from '../../../features/identity/schemas/stations.schema.js';
import { transferRunsTable } from '../schemas/transfer-runs.schema.js';
import type { PaginationParams } from '../../pagination/pagination.js';
import type { TransferContext, TransferResource } from '../types.js';
import type { ImportCommitReport } from './import.service.js';

export interface WireTransferRun {
  id: number;
  resource: string;
  kind: 'export' | 'import';
  user_name: string | null;
  station_name: string | null;
  file_name: string | null;
  format: string | null;
  row_count: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  created_at: string;
}

/**
 * Writes the run — **and never fails the operation it describes**. The rows
 * are already in the database (or the file already on the wire) by the time
 * this runs; answering an error now would make the user retry something that
 * succeeded. A lost log line is logged instead.
 */
async function record(values: typeof transferRunsTable.$inferInsert): Promise<void> {
  try {
    await db.insert(transferRunsTable).values(values);
  } catch (err: unknown) {
    logger.error({ err, resource: values.resource, kind: values.kind }, 'data transfer run not recorded');
  }
}

const formatOf = (fileName: string | null): string | null => {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  return ext === 'csv' || ext === 'xlsx' ? ext : null;
};

export function recordExportRun(
  resource: TransferResource,
  ctx: TransferContext,
  plan: { filename: string; rowCount: number },
): Promise<void> {
  return record({
    resource: resource.name,
    kind: 'export',
    user_id: ctx.userId,
    station_id: ctx.stationId ?? null,
    file_name: plan.filename.slice(0, 200),
    format: formatOf(plan.filename),
    row_count: plan.rowCount,
  });
}

export function recordImportRun(
  resource: TransferResource,
  ctx: TransferContext,
  fileName: string | null,
  report: ImportCommitReport,
): Promise<void> {
  return record({
    resource: resource.name,
    kind: 'import',
    user_id: ctx.userId,
    station_id: ctx.stationId ?? null,
    file_name: fileName?.slice(0, 200) ?? null,
    format: formatOf(fileName),
    inserted: report.inserted,
    updated: report.updated,
    skipped: report.skipped,
    failed: report.failed,
  });
}

/**
 * The runs of [resources] — the names the caller may export, decided by the
 * controller with each resource's own guard, so the log shows exactly the
 * data the reader could have moved themselves.
 */
export async function listRuns(
  resources: string[],
  params: PaginationParams,
): Promise<{ items: WireTransferRun[]; total: number }> {
  if (resources.length === 0) return { items: [], total: 0 };
  const where = and(inArray(transferRunsTable.resource, resources));

  const [rows, totals] = await Promise.all([
    db
      .select({
        run: transferRunsTable,
        user_name: sql<string | null>`${usersTable.first_name} || ' ' || ${usersTable.last_name}`,
        station_name: stationsTable.name,
      })
      .from(transferRunsTable)
      .leftJoin(usersTable, eq(usersTable.id, transferRunsTable.user_id))
      .leftJoin(stationsTable, eq(stationsTable.id, transferRunsTable.station_id))
      .where(where)
      .orderBy(desc(transferRunsTable.created_at), desc(transferRunsTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ n: count() }).from(transferRunsTable).where(where),
  ]);

  return {
    items: rows.map(({ run, user_name, station_name }) => ({
      id: run.id,
      resource: run.resource,
      kind: run.kind === 'import' ? 'import' : 'export',
      user_name: user_name ?? null,
      station_name: station_name ?? null,
      file_name: run.file_name,
      format: run.format,
      row_count: run.row_count,
      inserted: run.inserted,
      updated: run.updated,
      skipped: run.skipped,
      failed: run.failed,
      created_at: run.created_at.toISOString(),
    })),
    total: Number(totals[0]?.n ?? 0),
  };
}
