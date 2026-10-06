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
): Promise<{ id: number; name: string; code: string } | undefined> {
  const [row] = await db
    .select({
      id: branchesTable.id,
      name: branchesTable.name,
      code: branchesTable.code,
      status: branchesTable.status,
      archived_at: branchesTable.archived_at,
    })
    .from(branchesTable)
    .where(eq(branchesTable.id, branchId))
    .limit(1);
  if (!row || row.archived_at !== null || row.status !== 'active') return undefined;
  return { id: row.id, name: row.name, code: row.code };
}

export async function findBranchName(branchId: number): Promise<string | null> {
  const [row] = await db
    .select({ name: branchesTable.name })
    .from(branchesTable)
    .where(eq(branchesTable.id, branchId))
    .limit(1);
  return row?.name ?? null;
}

export async function insertJob(values: NewPrintJobRow, exec: Exec = db): Promise<PrintJobRow> {
  const [row] = await exec.insert(printJobsTable).values(values).returning();
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

/** Ready jobs carrying this pickup code — two at most, to tell «ambiguous» from «one». */
export async function findReadyByPickupCode(branchId: number, code: string): Promise<PrintJobRow[]> {
  return db
    .select()
    .from(printJobsTable)
    .where(
      and(
        eq(printJobsTable.branch_id, branchId),
        eq(printJobsTable.status, 'ready'),
        sql`upper(${printJobsTable.pickup_code}) = ${code}`,
      ),
    )
    .limit(2);
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

export async function findBranchCode(tx: Tx, branchId: number): Promise<string | null> {
  const [row] = await tx
    .select({ code: branchesTable.code })
    .from(branchesTable)
    .where(eq(branchesTable.id, branchId))
    .limit(1);
  return row?.code ?? null;
}

/**
 * Ready jobs at [branchId] matching [q] — the pickup code or order number
 * exactly (case aside), the number's **tail** (`000002` for `BR1-P-2026-000002`:
 * what a cashier types), or the customer's phone or name in part. At most 20:
 * a till scans for one job, and a name that matches more is a name to narrow.
 */
/**
 * Every order the customer at the till could mean (9-ح-2 audit) — **not ready
 * ones only**: the rule is pay before printing, so the order the customer
 * comes to pay for is still «to pay». Open orders of any stage, plus those
 * closed in the last two weeks (said as closed, so «it expired» is an answer
 * rather than «not found»). Counter prints never are looked up — they are
 * printed while the customer stands there. Ready first, then to pay.
 */
export async function findForTill(branchId: number, q: string): Promise<PrintJobRow[]> {
  if (q.length === 0) return [];
  const upper = q.toUpperCase();
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const tail = /^\d{3,}$/.test(q) ? `%-${q}` : null;
  const rows = await db
    .select({ job: printJobsTable })
    .from(printJobsTable)
    .leftJoin(customersTable, eq(customersTable.id, printJobsTable.customer_id))
    .where(
      and(
        eq(printJobsTable.branch_id, branchId),
        sql`${printJobsTable.status} <> 'draft'`,
        sql`${printJobsTable.source} <> 'counter'`,
        sql`(${printJobsTable.closed_at} IS NULL OR ${printJobsTable.closed_at} > now() - interval '14 days')`,
        sql`(upper(${printJobsTable.pickup_code}) = ${upper}
          OR upper(${printJobsTable.number}) = ${upper}
          OR (${tail !== null} AND upper(${printJobsTable.number}) LIKE ${tail ?? ''})
          OR ${customersTable.phone} ILIKE ${like}
          OR (${customersTable.first_name} || ' ' || ${customersTable.last_name}) ILIKE ${like}
          OR ${printJobsTable.contact_name} ILIKE ${like}
          OR ${printJobsTable.contact_phone} ILIKE ${like}
          OR ${printJobsTable.label} ILIKE ${like})`,
      ),
    )
    .orderBy(
      sql`CASE ${printJobsTable.status}
        WHEN 'ready' THEN 0 WHEN 'awaiting_payment' THEN 1 WHEN 'queued' THEN 2
        WHEN 'in_production' THEN 2 WHEN 'awaiting_quote' THEN 3 ELSE 4 END`,
      desc(printJobsTable.submitted_at),
    )
    .limit(20);
  return rows.map((r) => r.job);
}

/**
 * Who a counter print is for (9-ح-1) — registered customers by name or phone,
 * then names typed on earlier counter orders (regulars without an account).
 * At most ten of each: a suggestion list, not a directory.
 */
export async function findContacts(q: string): Promise<{
  customers: { id: number; name: string; phone: string | null }[];
  contacts: { name: string; phone: string | null }[];
}> {
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const [customers, contacts] = await Promise.all([
    db
      .select({
        id: customersTable.id,
        first: customersTable.first_name,
        last: customersTable.last_name,
        phone: customersTable.phone,
      })
      .from(customersTable)
      .where(
        sql`(${customersTable.phone} ILIKE ${like} OR (${customersTable.first_name} || ' ' || ${customersTable.last_name}) ILIKE ${like})`,
      )
      .limit(10),
    db
      .selectDistinct({ name: printJobsTable.contact_name, phone: printJobsTable.contact_phone })
      .from(printJobsTable)
      .where(
        sql`${printJobsTable.contact_name} IS NOT NULL AND (${printJobsTable.contact_name} ILIKE ${like} OR ${printJobsTable.contact_phone} ILIKE ${like})`,
      )
      .limit(10),
  ]);
  return {
    customers: customers.map((c) => ({ id: c.id, name: `${c.first} ${c.last}`.trim(), phone: c.phone })),
    contacts: contacts.map((c) => ({ name: c.name ?? '', phone: c.phone })),
  };
}

/** How many open jobs sit at each stage, over [branchIds]. */
export async function countByStatus(branchIds: number[]): Promise<Map<PrintJobStatus, number>> {
  const out = new Map<PrintJobStatus, number>();
  if (branchIds.length === 0) return out;
  const rows = await db
    .select({ status: printJobsTable.status, n: count() })
    .from(printJobsTable)
    .where(
      and(
        inArray(printJobsTable.branch_id, branchIds),
        inArray(printJobsTable.status, ['awaiting_quote', 'awaiting_payment', 'queued', 'in_production', 'ready']),
        sql`${printJobsTable.source} <> 'counter'`,
      ),
    )
    .groupBy(printJobsTable.status);
  for (const r of rows) out.set(r.status, Number(r.n));
  return out;
}

const CLOSED_STATUSES: readonly PrintJobStatus[] = ['picked_up', 'cancelled', 'expired'];

export async function findJobs(
  filters: {
    branchId?: number;
    customerId?: number;
    statuses?: PrintJobStatus[];
    excludeDrafts?: boolean;
    excludeCounter?: boolean;
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
  // Counter prints are printed at the till, not board work (9-ح-1).
  if (filters.excludeCounter) where.push(sql`${printJobsTable.source} <> 'counter'`);
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
          : // History (closed orders, 9-ح-2): the latest closed first — nobody
            // looks for what was picked up a week ago before today's.
            filters.statuses?.length && filters.statuses.every((s) => CLOSED_STATUSES.includes(s))
            ? [desc(printJobsTable.closed_at), desc(printJobsTable.id)]
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
