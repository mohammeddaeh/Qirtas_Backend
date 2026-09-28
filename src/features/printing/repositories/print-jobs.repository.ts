import { and, asc, count, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { customersTable } from '../../customers/schemas/customers.schema.js';
import {
  mediaAssetsTable,
  type MediaAssetRow,
} from '../../../core/media/schemas/media-assets.schema.js';
import {
  printJobFilesTable,
  printJobLinksTable,
  printJobSequencesTable,
  printJobsTable,
  type NewPrintJobRow,
  type PrintJobLinkRow,
  type PrintJobRow,
  type PrintJobStatus,
} from '../schemas/print-jobs.schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

export async function findCustomer(
  customerId: number,
): Promise<{ id: number; name: string; phone: string | null; status: string } | undefined> {
  const [row] = await db
    .select({
      id: customersTable.id,
      first_name: customersTable.first_name,
      last_name: customersTable.last_name,
      phone: customersTable.phone,
      status: customersTable.status,
    })
    .from(customersTable)
    .where(eq(customersTable.id, customerId))
    .limit(1);
  if (!row) return undefined;
  return {
    id: row.id,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
    phone: row.phone,
    status: row.status,
  };
}

/** فرعٌ يستقبل طلبات الزبائن: نشطٌ وغير مؤرشف (نفس قاعدة الطلبات). */
export async function findOpenBranch(
  branchId: number,
): Promise<{ id: number; name: string } | undefined> {
  const [row] = await db
    .select({
      id: branchesTable.id,
      name: branchesTable.name,
      status: branchesTable.status,
      archived_at: branchesTable.archived_at,
    })
    .from(branchesTable)
    .where(eq(branchesTable.id, branchId))
    .limit(1);
  if (!row || row.archived_at !== null || row.status !== 'active') return undefined;
  return { id: row.id, name: row.name };
}

export async function findBranchName(branchId: number): Promise<string | null> {
  const [row] = await db
    .select({ name: branchesTable.name })
    .from(branchesTable)
    .where(eq(branchesTable.id, branchId))
    .limit(1);
  return row?.name ?? null;
}

export async function insertJob(values: NewPrintJobRow): Promise<PrintJobRow> {
  const [row] = await db.insert(printJobsTable).values(values).returning();
  return row!;
}

export async function findJob(id: number, exec: Exec = db): Promise<PrintJobRow | undefined> {
  const [row] = await exec.select().from(printJobsTable).where(eq(printJobsTable.id, id)).limit(1);
  return row;
}

export async function findJobByNumber(
  branchId: number,
  number: string,
): Promise<PrintJobRow | undefined> {
  const [row] = await db
    .select()
    .from(printJobsTable)
    .where(and(eq(printJobsTable.branch_id, branchId), eq(printJobsTable.number, number)))
    .limit(1);
  return row;
}

/** يقفل الصفّ حتى نهاية المعاملة — تغييران متزامنان للحالة لا يمرّان معاً. */
export async function lockJob(exec: Tx, id: number): Promise<PrintJobRow | undefined> {
  const [row] = await exec
    .select()
    .from(printJobsTable)
    .where(eq(printJobsTable.id, id))
    .for('update')
    .limit(1);
  return row;
}

export async function updateJob(
  exec: Exec,
  id: number,
  patch: Partial<NewPrintJobRow>,
): Promise<void> {
  await exec
    .update(printJobsTable)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(printJobsTable.id, id));
}

export async function findJobs(
  filters: {
    branchId?: number;
    customerId?: number;
    statuses?: PrintJobStatus[];
    excludeDrafts?: boolean;
  },
  limit: number,
  offset: number,
): Promise<{ rows: PrintJobRow[]; total: number }> {
  const where: SQL[] = [];
  if (filters.branchId !== undefined) where.push(eq(printJobsTable.branch_id, filters.branchId));
  if (filters.customerId !== undefined)
    where.push(eq(printJobsTable.customer_id, filters.customerId));
  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    where.push(inArray(printJobsTable.status, filters.statuses));
  }
  // الطابور لا يرى المسودات: الزبون لم يُرسل بعد، وليست عملاً لأحد.
  if (filters.excludeDrafts) where.push(sql`${printJobsTable.status} <> 'draft'`);
  const condition = where.length === 0 ? undefined : and(...where);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(printJobsTable)
      .where(condition)
      // الطابور: الأقدم إرسالاً أولاً (من انتظر أطول). والزبون: الأحدث أولاً.
      .orderBy(
        ...(filters.customerId !== undefined
          ? [desc(printJobsTable.created_at), desc(printJobsTable.id)]
          : [asc(printJobsTable.submitted_at), asc(printJobsTable.id)]),
      )
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(printJobsTable).where(condition),
  ]);
  return { rows, total: Number(totalRow?.n ?? 0) };
}

export async function findOverdueJobs(now: Date, limit: number): Promise<PrintJobRow[]> {
  return db
    .select()
    .from(printJobsTable)
    .where(
      and(eq(printJobsTable.status, 'awaiting_payment'), lte(printJobsTable.payment_due_at, now)),
    )
    .orderBy(asc(printJobsTable.payment_due_at))
    .limit(limit);
}

export async function nextJobSequence(exec: Exec, branchId: number, year: number): Promise<number> {
  const result = await exec.execute<{ last_sequence: number }>(
    sql`INSERT INTO ${printJobSequencesTable} (branch_id, year, last_sequence)
        VALUES (${branchId}, ${year}, 1)
        ON CONFLICT (branch_id, year)
        DO UPDATE SET last_sequence = ${printJobSequencesTable}.last_sequence + 1
        RETURNING last_sequence`,
  );
  return Number(result.rows[0]?.last_sequence ?? 1);
}

// ── الملفات والروابط ─────────────────────────────────────────────────────────

export interface JobFile {
  id: number;
  sort_order: number;
  asset: MediaAssetRow;
}

export async function findJobFiles(jobId: number, exec: Exec = db): Promise<JobFile[]> {
  const rows = await exec
    .select({ file: printJobFilesTable, asset: mediaAssetsTable })
    .from(printJobFilesTable)
    .innerJoin(mediaAssetsTable, eq(mediaAssetsTable.id, printJobFilesTable.media_asset_id))
    .where(eq(printJobFilesTable.job_id, jobId))
    .orderBy(asc(printJobFilesTable.sort_order), asc(printJobFilesTable.id));
  return rows.map((r) => ({ id: r.file.id, sort_order: r.file.sort_order, asset: r.asset }));
}

export async function findJobFile(jobId: number, fileId: number): Promise<JobFile | undefined> {
  const [row] = await db
    .select({ file: printJobFilesTable, asset: mediaAssetsTable })
    .from(printJobFilesTable)
    .innerJoin(mediaAssetsTable, eq(mediaAssetsTable.id, printJobFilesTable.media_asset_id))
    .where(and(eq(printJobFilesTable.job_id, jobId), eq(printJobFilesTable.id, fileId)))
    .limit(1);
  return row === undefined
    ? undefined
    : { id: row.file.id, sort_order: row.file.sort_order, asset: row.asset };
}

export async function insertJobFile(
  jobId: number,
  mediaAssetId: number,
  sortOrder: number,
): Promise<number> {
  const [row] = await db
    .insert(printJobFilesTable)
    .values({ job_id: jobId, media_asset_id: mediaAssetId, sort_order: sortOrder })
    .returning({ id: printJobFilesTable.id });
  return row!.id;
}

export async function deleteJobFile(jobId: number, fileId: number): Promise<void> {
  await db
    .delete(printJobFilesTable)
    .where(and(eq(printJobFilesTable.job_id, jobId), eq(printJobFilesTable.id, fileId)));
}

export async function findJobLinks(jobId: number, exec: Exec = db): Promise<PrintJobLinkRow[]> {
  return exec
    .select()
    .from(printJobLinksTable)
    .where(eq(printJobLinksTable.job_id, jobId))
    .orderBy(asc(printJobLinksTable.id));
}

export async function insertJobLink(
  jobId: number,
  url: string,
  note: string | null,
): Promise<void> {
  await db.insert(printJobLinksTable).values({ job_id: jobId, url, note });
}

export async function deleteJobLink(jobId: number, linkId: number): Promise<boolean> {
  const rows = await db
    .delete(printJobLinksTable)
    .where(and(eq(printJobLinksTable.job_id, jobId), eq(printJobLinksTable.id, linkId)))
    .returning({ id: printJobLinksTable.id });
  return rows.length > 0;
}
