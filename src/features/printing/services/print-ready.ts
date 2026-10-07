import { issueNumber } from '../../../core/numbering/numbering.js';
import { branchPrefix } from '../../../core/records/branch-prefix.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { recordFinance, type FinanceEntry } from '../../../core/finance/finance-recorder.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import { likeTerm } from '../../../core/db/like-term.js';
import {
  registerServiceLineHandler,
  type ServiceExec,
  type ServiceKind,
  type ServiceLineHandler,
  type ServiceLineQuote,
  type ServiceReturnInfo,
  type ServiceReturnInput,
} from '../../../core/till/service-line-port.js';
import { printCounterSalesTable } from '../schemas/print-counter-sales.schema.js';
import * as printingRepo from '../repositories/printing.repository.js';
import { printJobsTable } from '../schemas/print-jobs.schema.js';
import {
  printReadyCopiesTable,
  printReadySalesTable,
  printReadyWriteOffsTable,
  type PrintReadyCopyRow,
} from '../schemas/print-ready.schema.js';
import { consumeForReprint } from './consumption.service.js';

/**
 * مرتجع الطباعة ورفّ الجاهز — `finance_ledger.md` §٢–§٤ (م-٢).
 *
 * **القيود**: عودة نسخة صالحة تعكس تكلفة موادها (`cogs_reversal`) وتسجّلها
 * قيمةً بالرفّ (`ready_shelf_in`) · التالفة تعكس وتخسر (`loss_print_return`) ·
 * إعادة الطباعة هدرٌ بلا ردّ (`print_waste`) · البيع من الجاهز تكلفته قيمة النسخة
 * (`ready_shelf_out`) · والشطب خسارةٌ بقيدٍ واحد (`loss_ready_writeoff`).
 * **قيمة الرفّ** = Σ داخل + Σ خارج + Σ مشطوب (بإشاراتها).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const num = (v: string | null): number => (v === null ? 0 : Number(v));

// ── المصدر: ما بِيع، وكم كلّف ────────────────────────────────────────────────

interface PrintSource {
  branchId: number;
  label: string | null;
  optionIds: (number | null)[];
  pages: number | null;
  copies: number;
  /** تكلفة مواد النسخة — `null` حين لم يُطبع بعد. */
  unitValueSyp: number | null;
  unitPriceSyp: number;
  sheets: number;
  printedPages: number;
  printJobId: number | null;
  printCounterId: number | null;
}

async function sourceOf(exec: ServiceExec, kind: ServiceKind, refId: number): Promise<PrintSource> {
  if (kind === 'print_counter') {
    const [r] = await exec.select().from(printCounterSalesTable).where(eq(printCounterSalesTable.id, refId)).limit(1);
    if (!r) throw new NotFoundError('Print sale not found');
    const q = r.quote as { sheets?: number; printed_pages?: number };
    return {
      branchId: r.branch_id,
      label: r.label,
      optionIds: [r.paper_size_id, r.color_mode_id, r.sides_id, r.binding_id, r.cover_id],
      pages: r.pages,
      copies: r.copies,
      unitValueSyp: r.materials_cost_syp === null ? null : num(r.materials_cost_syp) / r.copies,
      unitPriceSyp: num(r.total_syp) / r.copies,
      sheets: q.sheets ?? 0,
      printedPages: q.printed_pages ?? 0,
      printJobId: null,
      printCounterId: r.id,
    };
  }
  if (kind === 'print_job') {
    const [j] = await exec.select().from(printJobsTable).where(eq(printJobsTable.id, refId)).limit(1);
    if (!j) throw new NotFoundError('Print order not found');
    const q = (j.quote ?? {}) as { sheets?: number; printed_pages?: number };
    return {
      branchId: j.branch_id,
      label: j.label,
      optionIds: [j.paper_size_id, j.color_mode_id, j.sides_id, j.binding_id, j.cover_id],
      pages: j.total_pages,
      copies: j.copies,
      unitValueSyp: j.materials_cost_syp === null ? null : num(j.materials_cost_syp) / j.copies,
      unitPriceSyp: num(j.quoted_total_syp) / j.copies,
      sheets: q.sheets ?? 0,
      printedPages: q.printed_pages ?? 0,
      printJobId: j.id,
      printCounterId: null,
    };
  }
  const [s] = await exec.select().from(printReadySalesTable).where(eq(printReadySalesTable.id, refId)).limit(1);
  if (!s) throw new NotFoundError('Ready sale not found');
  const [c] = await exec.select().from(printReadyCopiesTable).where(eq(printReadyCopiesTable.id, s.ready_copy_id)).limit(1);
  return {
    branchId: s.branch_id,
    label: c?.label ?? null,
    optionIds: c ? [c.paper_size_id, c.color_mode_id, c.sides_id, c.binding_id, c.cover_id] : [],
    pages: c?.pages ?? null,
    copies: s.copies,
    unitValueSyp: c ? num(c.unit_value_syp) : 0,
    unitPriceSyp: num(s.unit_price_syp),
    sheets: 0,
    printedPages: 0,
    printJobId: null,
    printCounterId: null,
  };
}

export async function printReturnInfo(kind: ServiceKind, refId: number): Promise<ServiceReturnInfo> {
  const src = await sourceOf(db, kind, refId);
  // طلبٌ دُفع ولم يُطبع: لا نسخة تعود ولا مادة تُعكس — إلغاؤه بعد الدفع قرارٌ
  // معلّق (`printing_system.md` 9-ج-3 #٤)، لا مرتجع.
  if (src.unitValueSyp === null) {
    return { copies: src.copies, label: src.label, returnable: false, whyNot: 'print_job_not_printed' };
  }
  return { copies: src.copies, label: src.label, returnable: true, whyNot: null };
}

/** يُستدعى من الصندوق **بمعاملة المرتجع** — المال للصندوق، والنسخ وقيمتها هنا. */
export async function processPrintReturn(
  exec: ServiceExec,
  kind: ServiceKind,
  input: ServiceReturnInput,
): Promise<void> {
  const tx = exec as Tx;
  const src = await sourceOf(tx, kind, input.refId);
  if (src.unitValueSyp === null) {
    throw new BusinessError(409, 'This print order was never printed', 'print_job_not_printed');
  }
  if (input.disposition === 'reprint' && kind === 'print_ready') {
    throw new BusinessError(422, 'A ready copy is not reprinted', 'print_return_no_reprint');
  }
  const value = src.unitValueSyp * input.copies;
  const base = {
    branchId: input.branchId,
    method: 'value' as const,
    saleId: input.saleId,
    userId: input.userId,
    reason: input.reasonCode,
  };
  const entries: FinanceEntry[] = [];

  if (input.disposition === 'reprint') {
    // النسخة السيئة ذهبت، والجديدة مواد بلا مالٍ مقابلها: هدر.
    const share = input.copies / src.copies;
    await consumeForReprint(
      tx,
      {
        branchId: input.branchId,
        optionIds: src.optionIds.filter((v): v is number => v !== null),
        sheets: src.sheets * share,
        printedPages: src.printedPages * share,
        copies: input.copies,
        printJobId: src.printJobId,
        printCounterId: src.printCounterId,
        saleId: input.saleId,
      },
      input.userId,
    );
    return;
  }

  entries.push({ ...base, type: 'cogs_reversal', amountSyp: value, docType: 'sale_return', docId: input.returnId });

  if (input.disposition === 'damaged') {
    entries.push({ ...base, type: 'loss_print_return', amountSyp: -value, docType: 'sale_return', docId: input.returnId });
  } else {
    const label = (input.label ?? src.label ?? '').trim();
    if (label.length === 0) {
      throw new BusinessError(422, 'A ready copy needs a name', 'print_return_label_required');
    }
    const [branchRow] = await tx
      .select({ code: branchesTable.code })
      .from(branchesTable)
      .where(eq(branchesTable.id, input.branchId))
      .limit(1);
    const { number } = await issueNumber(tx, 'ready_copy', branchPrefix(branchRow?.code, input.branchId));
    const [copy] = await tx
      .insert(printReadyCopiesTable)
      .values({
        number,
        branch_id: input.branchId,
        label: label.slice(0, 120),
        paper_size_id: src.optionIds[0] ?? null,
        color_mode_id: src.optionIds[1] ?? null,
        sides_id: src.optionIds[2] ?? null,
        binding_id: src.optionIds[3] ?? null,
        cover_id: src.optionIds[4] ?? null,
        pages: src.pages,
        copies_in: input.copies,
        copies_available: input.copies,
        unit_value_syp: src.unitValueSyp.toFixed(2),
        unit_price_syp: src.unitPriceSyp.toFixed(2),
        source_return_id: input.returnId,
        source_sale_id: input.saleId,
        created_by: input.userId,
      })
      .returning();
    entries.push({ ...base, type: 'ready_shelf_in', amountSyp: value, docType: 'ready_copy', docId: copy!.id });
  }
  await recordFinance(tx, entries);
}

// ── الرفّ: قراءة · بيع · شطب ────────────────────────────────────────────────

export interface WireReadyCopy {
  id: number;
  number: string;
  branch_id: number;
  label: string;
  status: PrintReadyCopyRow['status'];
  pages: number | null;
  copies_in: number;
  copies_available: number;
  unit_value_syp: number;
  unit_price_syp: number;
  source_sale_id: number | null;
  source_return_id: number | null;
  created_at: string;
}

export const readyNumber = (id: number): string => `J-${String(id).padStart(4, '0')}`;

function toWire(r: PrintReadyCopyRow): WireReadyCopy {
  return {
    id: r.id,
    number: r.number ?? readyNumber(r.id),
    branch_id: r.branch_id,
    label: r.label,
    status: r.status,
    pages: r.pages,
    copies_in: r.copies_in,
    copies_available: r.copies_available,
    unit_value_syp: num(r.unit_value_syp),
    unit_price_syp: num(r.unit_price_syp),
    source_sale_id: r.source_sale_id,
    source_return_id: r.source_return_id,
    created_at: r.created_at.toISOString(),
  };
}

/** نسخ الفرع — والبحث **بالاسم** (قرار المستخدم): هكذا يُنبَّه على الجاهز. */
export async function listReadyCopies(filter: {
  branchId: number;
  search?: string;
  includeClosed?: boolean;
}): Promise<WireReadyCopy[]> {
  const where = [eq(printReadyCopiesTable.branch_id, filter.branchId)];
  if (!filter.includeClosed) where.push(eq(printReadyCopiesTable.status, 'available'));
  if (filter.search?.trim()) where.push(ilike(printReadyCopiesTable.label, likeTerm(filter.search)));
  const rows = await db
    .select()
    .from(printReadyCopiesTable)
    .where(and(...where))
    .orderBy(desc(printReadyCopiesTable.created_at))
    .limit(200);
  return rows.map(toWire);
}

async function lockCopy(tx: Tx, id: number): Promise<PrintReadyCopyRow> {
  const [row] = await tx.select().from(printReadyCopiesTable).where(eq(printReadyCopiesTable.id, id)).for('update').limit(1);
  if (!row) throw new NotFoundError('Ready copy not found');
  return row;
}

function assertAvailable(row: PrintReadyCopyRow, copies: number): void {
  if (row.status !== 'available' || row.copies_available < copies) {
    throw new BusinessError(409, 'Not that many ready copies left', 'print_ready_not_enough', {
      available: row.status === 'available' ? row.copies_available : 0,
    });
  }
}

/** بيعٌ من الجاهز **بسعرٍ حرّ** — يُحفظ مفتوحاً حتى يضيفه الصندوق بـ`print_ready`. */
export async function createReadySale(
  userId: number,
  copyId: number,
  body: {
    copies: number;
    unit_price_syp: number;
    customer_id?: number | null;
    contact_name?: string | null;
    contact_phone?: string | null;
  },
): Promise<{ id: number; total_syp: number }> {
  const [copy] = await db.select().from(printReadyCopiesTable).where(eq(printReadyCopiesTable.id, copyId)).limit(1);
  if (!copy) throw new NotFoundError('Ready copy not found');
  assertAvailable(copy, body.copies);
  const total = Math.round(body.copies * body.unit_price_syp * 100) / 100;
  const [row] = await db
    .insert(printReadySalesTable)
    .values({
      ready_copy_id: copy.id,
      branch_id: copy.branch_id,
      copies: body.copies,
      unit_price_syp: body.unit_price_syp.toFixed(2),
      total_syp: total.toFixed(2),
      customer_id: body.customer_id ?? null,
      contact_name: body.customer_id ? null : body.contact_name?.trim() || null,
      contact_phone: body.customer_id ? null : body.contact_phone?.trim() || null,
      created_by: userId,
    })
    .returning();
  return { id: row!.id, total_syp: total };
}

/** شطب نسخٍ لم تُبع — خسارةٌ بقيمة موادها، بسببها. */
export async function writeOffReadyCopies(
  userId: number,
  copyId: number,
  body: { copies: number; reason_code: string; note?: string | null },
): Promise<WireReadyCopy> {
  const row = await db.transaction(async (tx) => {
    const copy = await lockCopy(tx, copyId);
    assertAvailable(copy, body.copies);
    const left = copy.copies_available - body.copies;
    const value = num(copy.unit_value_syp) * body.copies;
    const [updated] = await tx
      .update(printReadyCopiesTable)
      .set({ copies_available: left, status: left === 0 ? 'written_off' : 'available', updated_at: new Date() })
      .where(eq(printReadyCopiesTable.id, copyId))
      .returning();
    await tx
      .insert(printReadyWriteOffsTable)
      .values({
        ready_copy_id: copyId,
        copies: body.copies,
        value_syp: value.toFixed(2),
        reason_code: body.reason_code,
        note: body.note ?? null,
        created_by: userId,
      })
      .returning();
    await recordFinance(tx, [
      {
        branchId: copy.branch_id,
        type: 'loss_ready_writeoff',
        method: 'value',
        amountSyp: -value,
        docType: 'ready_copy',
        docId: copyId,
        saleId: copy.source_sale_id,
        userId,
        reason: body.reason_code,
        // The copy is the document (doc_id); the note is the reader's own words or nothing.
        note: body.note?.trim() || null,
      },
    ]);
    return updated!;
  });
  return toWire(row);
}

// ── سطر الصندوق `print_ready` ───────────────────────────────────────────────

async function resolve(input: { reference: string; branchId: number; saleId: number }): Promise<ServiceLineQuote> {
  const id = Number(input.reference.trim());
  const [s] = Number.isInteger(id)
    ? await db.select().from(printReadySalesTable).where(eq(printReadySalesTable.id, id)).limit(1)
    : [];
  if (!s || s.status !== 'open') {
    throw new BusinessError(404, 'No open ready-copy sale with this reference', 'print_ready_sale_not_found');
  }
  if (s.branch_id !== input.branchId) {
    throw new BusinessError(409, 'This ready copy is on another branch shelf', 'print_ready_other_branch');
  }
  const [c] = await db.select().from(printReadyCopiesTable).where(eq(printReadyCopiesTable.id, s.ready_copy_id)).limit(1);
  return {
    refId: s.id,
    nameAr: `${c?.label ?? 'مطبوع جاهز'} · جاهز ${readyNumber(s.ready_copy_id)} × ${s.copies}`,
    sku: readyNumber(s.ready_copy_id),
    amountSyp: num(s.total_syp),
    taxPercent: 0,
    customerId: null,
  };
}

async function attach(exec: ServiceExec, refId: number, saleId: number): Promise<void> {
  await exec.update(printReadySalesTable).set({ sale_id: saleId }).where(eq(printReadySalesTable.id, refId));
}

async function detach(exec: ServiceExec, refId: number): Promise<void> {
  await exec.update(printReadySalesTable).set({ status: 'void' }).where(eq(printReadySalesTable.id, refId));
}

/** سُدِّد: النسخ تغادر الرفّ، وتكلفتها قيمتها — **لا ورق جديد**. */
async function settle(exec: ServiceExec, refId: number, saleId: number, userId: number): Promise<void> {
  const tx = exec as Tx;
  const [s] = await tx.select().from(printReadySalesTable).where(eq(printReadySalesTable.id, refId)).for('update').limit(1);
  if (!s || s.status !== 'open' || s.sale_id !== saleId) {
    throw new BusinessError(409, 'This ready-copy sale cannot be paid now', 'print_ready_not_payable');
  }
  const copy = await lockCopy(tx, s.ready_copy_id);
  assertAvailable(copy, s.copies);
  const left = copy.copies_available - s.copies;
  await tx
    .update(printReadyCopiesTable)
    .set({ copies_available: left, status: left === 0 ? 'sold_out' : 'available', updated_at: new Date() })
    .where(eq(printReadyCopiesTable.id, copy.id));
  await tx.update(printReadySalesTable).set({ status: 'settled', settled_at: new Date() }).where(eq(printReadySalesTable.id, refId));
  await recordFinance(tx, [
    {
      branchId: copy.branch_id,
      type: 'ready_shelf_out',
      method: 'value',
      amountSyp: -num(copy.unit_value_syp) * s.copies,
      docType: 'ready_copy',
      docId: copy.id,
      saleId,
      userId,
    },
  ]);
}

const readyHandler: ServiceLineHandler = {
  kind: 'print_ready',
  resolve,
  attach,
  detach,
  settle,
  returnInfo: (refId) => printReturnInfo('print_ready', refId),
  processReturn: (exec, input) => processPrintReturn(exec, 'print_ready', input),
};

export function installPrintReadyServiceLine(): void {
  registerServiceLineHandler(readyHandler);
}

/** Days after which a shelf copy is marked old (9-ح-3, a printing setting). */
export async function readyStaleDays(): Promise<number> {
  return (await printingRepo.getSettings()).ready_stale_days;
}

/** للتقارير لاحقاً — عدد ما على الرفّ وقيمته. */
export async function shelfSummary(branchId: number): Promise<{ copies: number; value_syp: number }> {
  const [r] = await db
    .select({
      copies: sql<string>`coalesce(sum(${printReadyCopiesTable.copies_available}), 0)`,
      value: sql<string>`coalesce(sum(${printReadyCopiesTable.copies_available} * ${printReadyCopiesTable.unit_value_syp}), 0)`,
    })
    .from(printReadyCopiesTable)
    .where(and(eq(printReadyCopiesTable.branch_id, branchId), eq(printReadyCopiesTable.status, 'available')));
  return { copies: Number(r?.copies ?? 0), value_syp: Number(r?.value ?? 0) };
}

/**
 * A paid app order handed over from the ready shelf — **inside the job's
 * transaction**. The copies leave the shelf and their value becomes this
 * order's cost (`ready_shelf_out`), exactly like a sale from the shelf; no
 * paper moves, nothing is printed. Returns the value taken.
 */
export async function takeReadyForJob(
  tx: Tx,
  input: { copyId: number; branchId: number; copies: number; jobId: number; saleId: number | null; userId: number },
): Promise<{ value: number; number: string }> {
  const copy = await lockCopy(tx, input.copyId);
  if (copy.branch_id !== input.branchId) {
    throw new BusinessError(409, 'This ready copy is on another branch shelf', 'print_ready_other_branch');
  }
  assertAvailable(copy, input.copies);
  const left = copy.copies_available - input.copies;
  await tx
    .update(printReadyCopiesTable)
    .set({ copies_available: left, status: left === 0 ? 'sold_out' : 'available', updated_at: new Date() })
    .where(eq(printReadyCopiesTable.id, copy.id));
  const value = num(copy.unit_value_syp) * input.copies;
  await recordFinance(tx, [
    {
      branchId: input.branchId,
      type: 'ready_shelf_out',
      method: 'value',
      amountSyp: -value,
      docType: 'ready_copy',
      docId: copy.id,
      saleId: input.saleId,
      userId: input.userId,
      note: `print_job:${input.jobId}`,
    },
  ]);
  return { value, number: copy.number ?? readyNumber(copy.id) };
}
