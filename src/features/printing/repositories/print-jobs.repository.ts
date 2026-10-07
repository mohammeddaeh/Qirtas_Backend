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
  type PrintPaymentStatus,
} from '../schemas/print-jobs.schema.js';
import { printReadyCopiesTable, printReadySalesTable } from '../schemas/print-ready.schema.js';

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

// ── The record (9-ح-5) — every print, every source ──────────────────────────

export type RecordSource = 'app' | 'counter' | 'shelf';

export interface RecordFilters {
  branchIds: number[];
  q?: string;
  /** `shelf` — copies sold off the ready shelf (`print_ready_sales`, not jobs). */
  source?: RecordSource;
  /** `open` — not closed yet · `done` — picked up / sold · `dropped` — cancelled or expired. */
  state?: 'open' | 'done' | 'dropped';
  from?: Date;
  /** Exclusive. */
  to?: Date;
  customerId?: number;
}

/**
 * Free search over one job — order number or its tail, pickup code, the
 * account's name or phone (by subquery: no join needed), the typed name and
 * phone, the print's name. The record and the board search the same way.
 */
export function jobSearchCondition(q: string | undefined): SQL | undefined {
  const t = q?.trim();
  if (!t) return undefined;
  const upper = t.toUpperCase();
  const like = likeOf(t);
  const tail = /^\d{3,}$/.test(t) ? `%-${t}` : null;
  return sql`(upper(${printJobsTable.pickup_code}) = ${upper}
    OR upper(${printJobsTable.number}) = ${upper}
    OR (${tail !== null} AND upper(${printJobsTable.number}) LIKE ${tail ?? ''})
    OR ${printJobsTable.customer_id} IN (SELECT ${customersTable.id} FROM ${customersTable}
      WHERE ${customersTable.phone} ILIKE ${like}
         OR (${customersTable.first_name} || ' ' || ${customersTable.last_name}) ILIKE ${like})
    OR ${printJobsTable.contact_name} ILIKE ${like}
    OR ${printJobsTable.contact_phone} ILIKE ${like}
    OR ${printJobsTable.label} ILIKE ${like})`;
}

function likeOf(q: string): string {
  return `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

const jobAt = sql`coalesce(${printJobsTable.submitted_at}, ${printJobsTable.created_at})`;

function recordWhere(f: RecordFilters): SQL | undefined {
  if (f.branchIds.length === 0 || f.source === 'shelf') return sql`false`;
  const where: SQL[] = [inArray(printJobsTable.branch_id, f.branchIds), sql`${printJobsTable.status} <> 'draft'`];
  if (f.source) where.push(eq(printJobsTable.source, f.source));
  if (f.state === 'open') where.push(sql`${printJobsTable.closed_at} IS NULL`);
  if (f.state === 'done') where.push(eq(printJobsTable.status, 'picked_up'));
  if (f.state === 'dropped') where.push(inArray(printJobsTable.status, ['cancelled', 'expired']));
  if (f.customerId !== undefined) where.push(eq(printJobsTable.customer_id, f.customerId));
  if (f.from) where.push(sql`${jobAt} >= ${f.from}`);
  if (f.to) where.push(sql`${jobAt} < ${f.to}`);
  const search = jobSearchCondition(f.q);
  if (search) where.push(search);
  return and(...where);
}

/**
 * Shelf sales in the record — **settled ones only**: an open one sits in a
 * basket and may still go, a void one never happened. Sold is always «done».
 */
function shelfWhere(f: RecordFilters): SQL | undefined {
  if (f.branchIds.length === 0) return sql`false`;
  if (f.source !== undefined && f.source !== 'shelf') return sql`false`;
  if (f.state !== undefined && f.state !== 'done') return sql`false`;
  const where: SQL[] = [inArray(printReadySalesTable.branch_id, f.branchIds), eq(printReadySalesTable.status, 'settled')];
  if (f.customerId !== undefined) where.push(eq(printReadySalesTable.customer_id, f.customerId));
  if (f.from) where.push(sql`${printReadySalesTable.settled_at} >= ${f.from}`);
  if (f.to) where.push(sql`${printReadySalesTable.settled_at} < ${f.to}`);
  const q = f.q?.trim();
  if (q) {
    const like = likeOf(q);
    where.push(sql`(${printReadyCopiesTable.label} ILIKE ${like}
      OR ${customersTable.phone} ILIKE ${like}
      OR (${customersTable.first_name} || ' ' || ${customersTable.last_name}) ILIKE ${like}
      OR ${printReadySalesTable.contact_name} ILIKE ${like}
      OR ${printReadySalesTable.contact_phone} ILIKE ${like})`);
  }
  return and(...where);
}

function jobKeys(f: RecordFilters) {
  return db
    .select({ kind: sql<string>`'job'`.as('kind'), id: printJobsTable.id, at: sql<Date>`${jobAt}`.as('at') })
    .from(printJobsTable)
    .leftJoin(customersTable, eq(customersTable.id, printJobsTable.customer_id))
    .where(recordWhere(f));
}

function shelfKeys(f: RecordFilters) {
  return db
    .select({
      kind: sql<string>`'shelf'`.as('kind'),
      id: printReadySalesTable.id,
      at: sql<Date>`${printReadySalesTable.settled_at}`.as('at'),
    })
    .from(printReadySalesTable)
    .innerJoin(printReadyCopiesTable, eq(printReadyCopiesTable.id, printReadySalesTable.ready_copy_id))
    .leftJoin(customersTable, eq(customersTable.id, printReadySalesTable.customer_id))
    .where(shelfWhere(f));
}

export interface ShelfRecordRow {
  id: number;
  branch_id: number;
  sale_id: number | null;
  label: string;
  copies: number;
  total_syp: string;
  customer_id: number | null;
  customer_first: string | null;
  customer_last: string | null;
  customer_phone: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  settled_at: Date | null;
}

export type RecordRow = { kind: 'job'; job: PrintJobRow } | { kind: 'shelf'; shelf: ShelfRecordRow };

/** Newest first — the record is read backwards from today; jobs and shelf sales interleaved. */
export async function findRecord(
  f: RecordFilters,
  limit: number,
  offset: number,
): Promise<{ rows: RecordRow[]; total: number }> {
  const union = sql`(${jobKeys(f)}) UNION ALL (${shelfKeys(f)})`;
  const [page, totalResult] = await Promise.all([
    db.execute(sql`SELECT kind, id FROM (${union}) u ORDER BY at DESC NULLS LAST, id DESC LIMIT ${limit} OFFSET ${offset}`),
    db.execute(sql`SELECT count(*)::int AS n FROM (${union}) u`),
  ]);
  const keys = (page as unknown as { rows: { kind: string; id: number }[] }).rows;
  const jobIds = keys.filter((k) => k.kind === 'job').map((k) => Number(k.id));
  const shelfIds = keys.filter((k) => k.kind === 'shelf').map((k) => Number(k.id));
  const [jobs, shelves] = await Promise.all([
    jobIds.length === 0 ? [] : db.select().from(printJobsTable).where(inArray(printJobsTable.id, jobIds)),
    shelfIds.length === 0
      ? []
      : db
          .select({
            id: printReadySalesTable.id,
            branch_id: printReadySalesTable.branch_id,
            sale_id: printReadySalesTable.sale_id,
            label: printReadyCopiesTable.label,
            copies: printReadySalesTable.copies,
            total_syp: printReadySalesTable.total_syp,
            customer_id: printReadySalesTable.customer_id,
            customer_first: customersTable.first_name,
            customer_last: customersTable.last_name,
            customer_phone: customersTable.phone,
            contact_name: printReadySalesTable.contact_name,
            contact_phone: printReadySalesTable.contact_phone,
            settled_at: printReadySalesTable.settled_at,
          })
          .from(printReadySalesTable)
          .innerJoin(printReadyCopiesTable, eq(printReadyCopiesTable.id, printReadySalesTable.ready_copy_id))
          .leftJoin(customersTable, eq(customersTable.id, printReadySalesTable.customer_id))
          .where(inArray(printReadySalesTable.id, shelfIds)),
  ]);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const shelfById = new Map(shelves.map((s) => [s.id, s]));
  const rows: RecordRow[] = [];
  for (const k of keys) {
    if (k.kind === 'job') {
      const job = jobById.get(Number(k.id));
      if (job) rows.push({ kind: 'job', job });
    } else {
      const shelf = shelfById.get(Number(k.id));
      if (shelf) rows.push({ kind: 'shelf', shelf });
    }
  }
  const total = Number((totalResult as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0);
  return { rows, total };
}

/** What the record's filters cover — counted and summed by the database. */
export async function recordSummary(f: RecordFilters) {
  const [[row], [shelf]] = await Promise.all([
    db
      .select({
        total: count(),
        app: sql<string>`count(*) filter (where ${printJobsTable.source} = 'app')`,
        counter: sql<string>`count(*) filter (where ${printJobsTable.source} = 'counter')`,
        open: sql<string>`count(*) filter (where ${printJobsTable.closed_at} is null)`,
        done: sql<string>`count(*) filter (where ${printJobsTable.status} = 'picked_up')`,
        dropped: sql<string>`count(*) filter (where ${printJobsTable.status} in ('cancelled', 'expired'))`,
        revenue: sql<string>`coalesce(sum(${printJobsTable.quoted_total_syp}) filter (where ${printJobsTable.payment_status} = 'paid'), 0)`,
        materials: sql<string>`coalesce(sum(${printJobsTable.materials_cost_syp}) filter (where ${printJobsTable.payment_status} = 'paid'), 0)`,
        pages: sql<string>`coalesce(sum(${printJobsTable.total_pages} * ${printJobsTable.copies}) filter (where ${printJobsTable.status} = 'picked_up'), 0)`,
        // Counter prints are ready the moment they are paid — they would pull the average to zero.
        avg_hours: sql<string | null>`avg(extract(epoch from (${printJobsTable.ready_at} - ${printJobsTable.submitted_at})) / 3600)
          filter (where ${printJobsTable.ready_at} is not null and ${printJobsTable.source} <> 'counter')`,
      })
      .from(printJobsTable)
      .leftJoin(customersTable, eq(customersTable.id, printJobsTable.customer_id))
      .where(recordWhere(f)),
    db
      .select({
        n: count(),
        revenue: sql<string>`coalesce(sum(${printReadySalesTable.total_syp}), 0)`,
      })
      .from(printReadySalesTable)
      .innerJoin(printReadyCopiesTable, eq(printReadyCopiesTable.id, printReadySalesTable.ready_copy_id))
      .leftJoin(customersTable, eq(customersTable.id, printReadySalesTable.customer_id))
      .where(shelfWhere(f)),
  ]);
  return { ...row!, shelf: shelf!.n, shelf_revenue: shelf!.revenue };
}

/** How many open jobs sit at each stage, over [branchIds]. */
export interface QueueFilters {
  q?: string;
  payment?: PrintPaymentStatus;
}

export async function countByStatus(branchIds: number[], f: QueueFilters = {}): Promise<Map<PrintJobStatus, number>> {
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
        f.payment ? eq(printJobsTable.payment_status, f.payment) : undefined,
        jobSearchCondition(f.q),
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
  } & QueueFilters,
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
  if (filters.payment) where.push(eq(printJobsTable.payment_status, filters.payment));
  const search = jobSearchCondition(filters.q);
  if (search) where.push(search);
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
