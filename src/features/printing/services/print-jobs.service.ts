import { issueNumber } from '../../../core/numbering/numbering.js';
import { takeReadyForJob } from './print-ready.js';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { DOCUMENT_TYPES, type DocumentType } from '../../../core/media/document-types.js';
import {
  completeDocument,
  documentDownloadUrl,
  reserveDocument,
  setDocumentExpiry,
  type DocumentPolicy,
} from '../../../core/media/documents.service.js';
import type { UploadTarget } from '../../../core/media/ports/storage-driver.js';
import type { MediaAssetStatus } from '../../../core/media/schemas/media-assets.schema.js';
import { branchPrefix } from '../../../core/records/branch-prefix.js';
import { PRINTING_AUDIT, printingTarget } from '../audit-actions.js';
import * as printingRepo from '../repositories/printing.repository.js';
import { emitPrintJobEvent, eventForStage } from './print-job-events.js';
import { tillSale } from '../../../core/till/service-line-port.js';
import { tillActionFor, type TillAction } from './job-rules.js';
import * as repo from '../repositories/print-jobs.repository.js';
import type { JobFile } from '../repositories/print-jobs.repository.js';
import type { PrintOptionKind } from '../schemas/printing.schema.js';
import type {
  PrintJobRow,
  PrintJobSource,
  PrintJobStatus,
  PrintPaymentStatus,
} from '../schemas/print-jobs.schema.js';
import { assertPrintableSpec, priceJob, type WireQuote } from './printing.service.js';
import {
  canSeeCost,
  consumeForJob,
  jobMaterials,
  type WireJobMaterials,
} from './consumption.service.js';
import {
  canMove,
  customerCanCancel,
  fileExpiryFor,
  hoursLeft,
  isEditable,
  isOverdue,
  isPrintableLink,
  nextStates,
  paymentDeadline,
  canHandOver,
  paymentSettled,
  submitProblem,
  type StaffStage,
} from './job-rules.js';

/**
 * طلب الطباعة — الشريحة 9-ج-2. **الملفات عامة بـ`core/media`** (حجز ← رفع
 * مباشر ← تأكيد)، وهذا الموديول يملك الطلب: لمن الملف، ومن يقرؤه، ومتى يُحذف.
 *
 * **صلاحية الملف صلاحية طلبه**: الزبون يرى طلبه وحده (وطلبُ غيره «غير موجود»)،
 * والموظف طلبات فرعه بمفتاحه **بذلك الفرع** — الحارس بالمسار يعرف أن المفتاح
 * محمولٌ بمكانٍ ما، ولا يعرف أيّ فرع، فالنطاق يُفحص هنا.
 */

export const QUEUE_VIEW_KEY = 'printing.queue.view';
export const STATUS_UPDATE_KEY = 'printing.status.update';
export const DEFER_KEY = 'printing.payment.defer';

/** طلبٌ بعشرين ملفاً طلبان؛ والسقف يمنع مسودةً تحجز مئات الروابط. */
export const MAX_FILES_PER_JOB = 20;
export const MAX_LINKS_PER_JOB = 20;

/** كل صيغة يعرفها `core/media` — قرار 2026-09-24: «كل الصيغ». */
const ALLOWED_TYPES: readonly DocumentType[] = DOCUMENT_TYPES;

const num = (v: string | null): number | null => (v === null ? null : Number(v));

// ── الشكل على السلك ──────────────────────────────────────────────────────────

export interface WireSpecOption {
  id: number;
  code: string;
  name_ar: string;
  name_en: string | null;
}

export interface WirePrintJobFile {
  id: number;
  name: string | null;
  bytes: number;
  /** ما تستطيع الواجهة قوله: يُرفع · جاهز · رُفض نوعه · حُذف بعد المدة. */
  status: MediaAssetStatus;
  /** ما **أثبتته البايتات** — `null` قبل التأكيد أو عند الرفض. */
  type: DocumentType | null;
}

export interface WirePrintJob {
  id: number;
  number: string | null;
  branch_id: number;
  branch_name: string | null;
  /** `null` for a regular known by name, or a walk-in (9-ح-1). */
  customer_id: number | null;
  /** The account's name — or the name typed at the counter; `null` = walk-in. */
  customer_name: string | null;
  customer_phone: string | null;
  source: PrintJobSource;
  status: PrintJobStatus;
  /** الأزرار تُبنى منها — لا آلة حالاتٍ ثانية بالعميل. */
  next_states: PrintJobStatus[];
  payment_status: PrintPaymentStatus;
  /**
   * بسلّة صندوقٍ لم تُدفع بعد: المهلة موقوفة، ولا تسعير ولا إلغاء — الكاشير
   * يقبض رقماً رآه الزبون.
   */
  at_till: boolean;
  /** الفاتورة التي حملته — بعد الدفع هي الجسر إلى الإيصال. */
  sale_id: number | null;
  paid_at: string | null;
  /** طُبع قبل الدفع بموافقة — باسم من قرّر ولماذا. `null` لغير المؤجَّل. */
  deferred: { by: number | null; at: string; reason: string | null } | null;
  spec: Record<PrintOptionKind, WireSpecOption | null>;
  copies: number;
  note: string | null;
  /** اسم المطبوع يكتبه الموظف عند التسعير (م-٢). */
  label: string | null;
  /** Handed over **wholly** from the ready shelf, not printed (`finance_ledger.md` §٤). */
  from_ready: boolean;
  /** `1005-042` — issued when ready, written on the copies (9-ز-2). `null` before. */
  pickup_code: string | null;
  /** Copies taken from the ready shelf (9-ز-5) — fewer than `copies` ⇒ the rest is printed. */
  from_ready_copies: number;
  /** صفحات النسخة الواحدة كما كتبها الموظف — `null` حتى يُسعَّر. */
  total_pages: number | null;
  /** تفصيل السعر المجمَّد — شكل `POST /printing/quote` نفسه. */
  quote: WireQuote | null;
  quoted_total_syp: number | null;
  quoted_at: string | null;
  payment_due_at: string | null;
  /** «يسقط خلال ٥ ساعات» — `null` بلا مهلة أو خارج انتظار الدفع. */
  hours_left: number | null;
  files: WirePrintJobFile[];
  links: { id: number; url: string; note: string | null }[];
  cancel_reason: string | null;
  created_at: string;
  submitted_at: string | null;
  production_started_at: string | null;
  ready_at: string | null;
  picked_up_at: string | null;
}

function wireFile(file: JobFile): WirePrintJobFile {
  return {
    id: file.id,
    name: file.asset.original_filename,
    bytes: file.asset.original_bytes,
    status: file.asset.status,
    type: file.asset.document_type,
  };
}

async function wireJob(row: PrintJobRow): Promise<WirePrintJob> {
  const [files, links, branchName, customer, options] = await Promise.all([
    repo.findJobFiles(row.id),
    repo.findJobLinks(row.id),
    repo.findBranchName(row.branch_id),
    row.customer_id === null ? Promise.resolve(undefined) : repo.findCustomer(row.customer_id),
    printingRepo.findOptions(),
  ]);
  const byId = new Map(options.map((o) => [o.id, o]));
  const option = (id: number): WireSpecOption | null => {
    const o = byId.get(id);
    return o === undefined
      ? null
      : { id: o.id, code: o.code, name_ar: o.name_ar, name_en: o.name_en };
  };
  const now = new Date();
  return {
    id: row.id,
    number: row.number,
    branch_id: row.branch_id,
    branch_name: branchName,
    customer_id: row.customer_id,
    customer_name: customer?.name ?? row.contact_name,
    customer_phone: customer?.phone ?? row.contact_phone,
    source: row.source,
    status: row.status,
    next_states: nextStates(row.status),
    payment_status: row.payment_status,
    // For the customer: at the till only while a cashier is at it — a basket
    // left open or held is not a payment in progress, and must not block cancel.
    at_till: isAtTill(row) && (await tillSale().state(row.sale_id!)) === 'active',
    sale_id: row.sale_id,
    paid_at: row.paid_at?.toISOString() ?? null,
    deferred:
      row.deferred_at === null
        ? null
        : { by: row.deferred_by, at: row.deferred_at.toISOString(), reason: row.deferred_reason },
    spec: {
      paper_size: option(row.paper_size_id),
      color_mode: option(row.color_mode_id),
      sides: option(row.sides_id),
      binding: option(row.binding_id),
      cover: option(row.cover_id),
    },
    copies: row.copies,
    note: row.note,
    label: row.label,
    // The whole order from the shelf — a partial take still printed the rest.
    from_ready: row.fulfilled_from_ready_id !== null && row.from_ready_copies >= row.copies,
    pickup_code: row.pickup_code,
    from_ready_copies: row.from_ready_copies,
    total_pages: row.total_pages,
    quote: (row.quote as WireQuote | null) ?? null,
    quoted_total_syp: num(row.quoted_total_syp),
    quoted_at: row.quoted_at?.toISOString() ?? null,
    payment_due_at: row.payment_due_at?.toISOString() ?? null,
    hours_left: row.status === 'awaiting_payment' ? hoursLeft(row.payment_due_at, now) : null,
    files: files.map(wireFile),
    links: links.map((l) => ({ id: l.id, url: l.url, note: l.note })),
    cancel_reason: row.cancel_reason,
    created_at: row.created_at.toISOString(),
    submitted_at: row.submitted_at?.toISOString() ?? null,
    production_started_at: row.production_started_at?.toISOString() ?? null,
    ready_at: row.ready_at?.toISOString() ?? null,
    picked_up_at: row.picked_up_at?.toISOString() ?? null,
  };
}

// ── أدوات ───────────────────────────────────────────────────────────────────

export interface SpecInput {
  paper_size_id: number;
  color_mode_id: number;
  sides_id: number;
  binding_id: number;
  cover_id: number;
}

const toSpec = (s: SpecInput) => ({
  paperSizeId: s.paper_size_id,
  colorModeId: s.color_mode_id,
  sidesId: s.sides_id,
  bindingId: s.binding_id,
  coverId: s.cover_id,
});

async function documentPolicy(): Promise<DocumentPolicy> {
  const settings = await printingRepo.getSettings();
  return { maxBytes: settings.max_file_mb * 1024 * 1024, allowed: ALLOWED_TYPES };
}

/**
 * طلبُ غيره **غير موجود** لا «ممنوع»: «ممنوع» تؤكّد أن الرقم صحيح، فيُجرَّب
 * التالي — نفس قاعدة «طلباتي».
 */
async function requireOwnJob(customerId: number, jobId: number): Promise<PrintJobRow> {
  await sweepOverdue();
  const row = await repo.findJob(jobId);
  if (!row || row.customer_id !== customerId) throw new NotFoundError('Print job not found');
  return row;
}

function isAtTill(row: PrintJobRow): boolean {
  return row.sale_id !== null && row.payment_status !== 'paid';
}

/** بسلّة صندوقٍ مفتوحة: تغيير السعر أو الإلغاء الآن يجعل الكاشير يقبض ما لم يعد صحيحاً. */
function requireNotAtTill(row: PrintJobRow): void {
  if (isAtTill(row)) {
    throw new BusinessError(409, 'This print order is at the till right now', 'print_job_at_till', {
      sale_id: row.sale_id,
    });
  }
}

function requireEditable(row: PrintJobRow): void {
  if (!isEditable(row.status)) {
    throw new BusinessError(
      409,
      'This print job can no longer be changed',
      'print_job_not_editable',
      {
        status: row.status,
      },
    );
  }
}

async function requireScope(
  actor: RequestActorContext,
  key: string,
  branchId: number,
): Promise<void> {
  if (!(await holdsPermissionAt(actor.userId, key, branchId))) {
    throw new BusinessError(403, 'No printing permission at this branch', 'print_scope_denied', {
      branch_id: branchId,
    });
  }
}

async function requireStaffJob(
  actor: RequestActorContext,
  key: string,
  jobId: number,
): Promise<PrintJobRow> {
  await sweepOverdue();
  const row = await repo.findJob(jobId);
  // المسودة ليست عملاً لأحد بعد — ولا يراها الموظف (الزبون لم يُرسلها).
  if (!row || row.status === 'draft') throw new NotFoundError('Print job not found');
  await requireScope(actor, key, row.branch_id);
  return row;
}

/**
 * يضبط موعد حذف ملفات الطلب بحالته الجديدة (`job-rules.ts` `fileExpiryFor`).
 * بعد الحالة لا قبلها: فشلٌ هنا يترك ملفاً يعيش أطول، لا طلباً بلا ملف.
 */
async function applyFileRetention(jobId: number, status: PrintJobStatus, at: Date): Promise<void> {
  const settings = await printingRepo.getSettings();
  const expiry = fileExpiryFor(status, at, settings.file_retention_days);
  if (expiry === 'unchanged') return;
  const files = await repo.findJobFiles(jobId);
  await setDocumentExpiry(
    files.map((f) => f.asset.id),
    expiry,
  );
}

// ── الزبون: المسودة ─────────────────────────────────────────────────────────

export async function createJob(
  customerId: number,
  input: SpecInput & { branch_id: number; copies: number; note?: string | null },
): Promise<WirePrintJob> {
  const [customer, branch] = await Promise.all([
    repo.findCustomer(customerId),
    repo.findOpenBranch(input.branch_id),
  ]);
  if (!customer) throw new NotFoundError('Customer not found');
  if (customer.status !== 'active') {
    throw new BusinessError(403, 'This account cannot order', 'order_account_not_active');
  }
  if (!branch)
    throw new BusinessError(404, 'This branch is not open for orders', 'branch_not_shoppable');
  // خيارٌ لا يطبعه الفرع يُرفض **الآن** لا بعد أن يرفع الزبون خمسين ميغابايت.
  await assertPrintableSpec(input.branch_id, toSpec(input));

  const row = await repo.insertJob({
    branch_id: input.branch_id,
    customer_id: customerId,
    status: 'draft',
    paper_size_id: input.paper_size_id,
    color_mode_id: input.color_mode_id,
    sides_id: input.sides_id,
    binding_id: input.binding_id,
    cover_id: input.cover_id,
    copies: input.copies,
    note: input.note?.trim() || null,
  });
  return wireJob(row);
}

export async function updateDraft(
  customerId: number,
  jobId: number,
  patch: Partial<SpecInput> & { copies?: number; note?: string | null },
): Promise<WirePrintJob> {
  const row = await requireOwnJob(customerId, jobId);
  requireEditable(row);
  const spec: SpecInput = {
    paper_size_id: patch.paper_size_id ?? row.paper_size_id,
    color_mode_id: patch.color_mode_id ?? row.color_mode_id,
    sides_id: patch.sides_id ?? row.sides_id,
    binding_id: patch.binding_id ?? row.binding_id,
    cover_id: patch.cover_id ?? row.cover_id,
  };
  await assertPrintableSpec(row.branch_id, toSpec(spec));
  await repo.updateJob(db, jobId, {
    ...spec,
    ...(patch.copies === undefined ? {} : { copies: patch.copies }),
    // المفتاح المُفرَّغ يمسح الملاحظة؛ الغائب يُبقيها.
    ...(patch.note === undefined ? {} : { note: patch.note?.trim() || null }),
  });
  return wireJob((await repo.findJob(jobId))!);
}

/**
 * الخطوة الأولى من رفع ملف: يُحجز ويُعاد **رابط الرفع** — الملف يذهب للمخزن
 * مباشرةً ولا يمرّ بالخادم. الحدّ والنوع المُعلَن يُرفضان هنا قبل أي بايت.
 */
export async function reserveFile(
  customerId: number,
  jobId: number,
  input: { filename: string; bytes: number },
): Promise<{ file: WirePrintJobFile; upload: UploadTarget }> {
  const row = await requireOwnJob(customerId, jobId);
  requireEditable(row);
  const files = await repo.findJobFiles(jobId);
  if (files.length >= MAX_FILES_PER_JOB) {
    throw new BusinessError(422, 'Too many files in one print job', 'print_job_too_many_files', {
      max_files: MAX_FILES_PER_JOB,
    });
  }
  const { asset, upload } = await reserveDocument({
    filename: input.filename,
    bytes: input.bytes,
    uploader: { customerId },
    policy: await documentPolicy(),
  });
  const sortOrder = files.reduce((max, f) => Math.max(max, f.sort_order), -1) + 1;
  const fileId = await repo.insertJobFile(jobId, asset.id, sortOrder);
  return { file: wireFile({ id: fileId, sort_order: sortOrder, asset }), upload };
}

/**
 * الخطوة الثالثة: اكتمل الرفع؟ يُفحص الحجم **والنوع من البايتات**. الملف
 * المرفوض يبقى بالطلب بحالته (`rejected`) ليرى الزبون أيّ ملف ولماذا، ويمنع
 * الإرسال حتى يحذفه — إسقاطه بصمت يجعل الطلب يصل الموظف ناقصاً.
 */
export async function completeFile(
  customerId: number,
  jobId: number,
  fileId: number,
): Promise<WirePrintJob> {
  const row = await requireOwnJob(customerId, jobId);
  requireEditable(row);
  const file = await repo.findJobFile(jobId, fileId);
  if (!file) throw new NotFoundError('File not found');
  await completeDocument(file.asset, await documentPolicy());
  return wireJob(row);
}

/** الحذف من المسودة وحدها. الملف يُسلَّم للكنّاس فوراً (لا يعيش أسبوعاً بعد أن سحبه صاحبه). */
export async function deleteFile(
  customerId: number,
  jobId: number,
  fileId: number,
): Promise<WirePrintJob> {
  const row = await requireOwnJob(customerId, jobId);
  requireEditable(row);
  const file = await repo.findJobFile(jobId, fileId);
  if (!file) throw new NotFoundError('File not found');
  await repo.deleteJobFile(jobId, fileId);
  await setDocumentExpiry([file.asset.id], new Date());
  return wireJob(row);
}

export async function addLink(
  customerId: number,
  jobId: number,
  input: { url: string; note?: string | null },
): Promise<WirePrintJob> {
  const row = await requireOwnJob(customerId, jobId);
  requireEditable(row);
  const url = input.url.trim();
  if (!isPrintableLink(url)) {
    throw new BusinessError(422, 'Only https links can be printed', 'print_link_invalid');
  }
  const links = await repo.findJobLinks(jobId);
  if (links.length >= MAX_LINKS_PER_JOB) {
    throw new BusinessError(422, 'Too many links in one print job', 'print_job_too_many_links', {
      max_links: MAX_LINKS_PER_JOB,
    });
  }
  await repo.insertJobLink(jobId, url, input.note?.trim() || null);
  return wireJob(row);
}

export async function deleteLink(
  customerId: number,
  jobId: number,
  linkId: number,
): Promise<WirePrintJob> {
  const row = await requireOwnJob(customerId, jobId);
  requireEditable(row);
  if (!(await repo.deleteJobLink(jobId, linkId))) throw new NotFoundError('Link not found');
  return wireJob(row);
}

/**
 * الإرسال: يُصرف الرقم ويدخل الطابور بـ`awaiting_quote` — **الموظف يعدّ الصفحات
 * ويسعّر**. والملفات تفقد مهلة «غير المُطالَب به»: الطلب صار يملكها.
 */
export async function submitJob(customerId: number, jobId: number): Promise<WirePrintJob> {
  const row = await requireOwnJob(customerId, jobId);
  requireEditable(row);
  const [files, links, branch] = await Promise.all([
    repo.findJobFiles(jobId),
    repo.findJobLinks(jobId),
    repo.findOpenBranch(row.branch_id),
  ]);
  if (!branch)
    throw new BusinessError(404, 'This branch is not open for orders', 'branch_not_shoppable');
  // المواصفة تُعاد: خيارٌ قد يكون أُوقف منذ أنشأ الزبون مسودّته.
  await assertPrintableSpec(row.branch_id, toSpec(row));

  const problem = submitProblem({
    readyFiles: files.filter((f) => f.asset.status === 'ready').length,
    pendingFiles: files.filter((f) => f.asset.status === 'pending').length,
    unusableFiles: files.filter(
      (f) => f.asset.status === 'rejected' || f.asset.status === 'deleted',
    ).length,
    links: links.length,
  });
  if (problem === 'nothing_to_print') {
    throw new BusinessError(422, 'Add a file or a link first', 'print_job_nothing_to_print');
  }
  if (problem === 'files_uploading') {
    throw new BusinessError(409, 'A file is still uploading', 'print_job_files_uploading');
  }
  if (problem === 'files_unusable') {
    throw new BusinessError(
      409,
      'Remove the files that cannot be printed',
      'print_job_files_unusable',
    );
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    const locked = await repo.lockJob(tx, jobId);
    if (!locked || locked.status !== 'draft') {
      throw new BusinessError(
        409,
        'This print job can no longer be changed',
        'print_job_not_editable',
        {
          status: locked?.status ?? null,
        },
      );
    }
    const { number, sequence } = await issueNumber(tx, 'print_job', branchPrefix(branch.code, branch.id));
    await repo.updateJob(tx, jobId, {
      number,
      sequence,
      status: 'awaiting_quote',
      submitted_at: now,
    });
  });
  await setDocumentExpiry(
    files.map((f) => f.asset.id),
    null,
  );
  const submitted = (await repo.findJob(jobId))!;
  emitPrintJobEvent('submitted', submitted);
  return wireJob(submitted);
}

// ── الزبون: القراءة والإلغاء ────────────────────────────────────────────────

export async function listMine(
  customerId: number,
  statuses: PrintJobStatus[] | undefined,
  limit: number,
  offset: number,
): Promise<{ items: WirePrintJob[]; total: number }> {
  await sweepOverdue();
  const { rows, total } = await repo.findJobs({ customerId, statuses }, limit, offset);
  return { items: await Promise.all(rows.map(wireJob)), total };
}

export async function getMine(customerId: number, jobId: number): Promise<WirePrintJob> {
  return wireJob(await requireOwnJob(customerId, jobId));
}

export async function cancelMine(
  customerId: number,
  jobId: number,
  reason?: string | null,
): Promise<WirePrintJob> {
  const row = await requireOwnJob(customerId, jobId);
  if (!customerCanCancel(row.status)) {
    throw new BusinessError(
      409,
      'This print job can no longer be cancelled',
      'print_job_not_cancellable',
      {
        status: row.status,
      },
    );
  }
  // On a forgotten basket (held, or open for hours): taken off it first, so
  // the cancel goes through. A basket being paid now still refuses (closeJob).
  if (isAtTill(row) && (await tillSale().state(row.sale_id!)) !== 'active') {
    await tillSale().release('print_job', row.id, row.sale_id!);
  }
  await closeJob(jobId, 'cancelled', reason?.trim() || null, null);
  return wireJob((await repo.findJob(jobId))!);
}

/** رابط قراءة ملفٍ من طلبه — للزبون صاحبه. عشر دقائق، وباسمه الأصلي. */
export async function myFileLink(
  customerId: number,
  jobId: number,
  fileId: number,
): Promise<{ url: string }> {
  await requireOwnJob(customerId, jobId);
  return { url: await fileLinkOf(jobId, fileId) };
}

async function fileLinkOf(jobId: number, fileId: number): Promise<string> {
  const file = await repo.findJobFile(jobId, fileId);
  if (!file) throw new NotFoundError('File not found');
  if (file.asset.status !== 'ready') {
    throw new BusinessError(409, 'This file cannot be opened', 'print_file_not_ready', {
      status: file.asset.status,
    });
  }
  return documentDownloadUrl(file.asset);
}

// ── الموظف: الطابور ─────────────────────────────────────────────────────────

/**
 * الطلب كما يراه الموظف — **ومعه تكلفة المواد والربح لمن يقرّر الأسعار وحده**
 * (`canSeeCost`)؛ لغيره `null`. والزبون لا يرى هذا الشكل أصلاً.
 */
export type WireStaffPrintJob = WirePrintJob & { materials: WireJobMaterials | null };

async function staffWire(row: PrintJobRow, seeCost: boolean): Promise<WireStaffPrintJob> {
  const [wire, materials] = await Promise.all([
    wireJob(row),
    seeCost ? jobMaterials(row) : Promise.resolve(null),
  ]);
  return { ...wire, materials };
}

async function staffWireFor(actor: RequestActorContext, jobId: number): Promise<WireStaffPrintJob> {
  const row = (await repo.findJob(jobId))!;
  return staffWire(row, await canSeeCost(actor.userId, row.branch_id));
}

/**
 * الفروع الحيّة التي يحمل القارئ فيها `printing.queue.view` — بها يُبنى منتقي
 * الطابور. عرضُ كل الفروع كان سيجعل موظف فرعٍ يختار فرعاً آخر فيُرفض.
 */
export async function queueBranches(
  actor: RequestActorContext,
): Promise<{ id: number; name: string }[]> {
  const branches = await printingRepo.findLiveBranches();
  const allowed = await Promise.all(
    branches.map((b) => holdsPermissionAt(actor.userId, QUEUE_VIEW_KEY, b.id)),
  );
  return branches.filter((_, i) => allowed[i]);
}

/** What the production board's stage row and the home tile count. */
export interface WireQueueCounts {
  to_price: number;
  awaiting_payment: number;
  /** Paid (or deferred) and waiting for the printer. */
  queued: number;
  in_production: number;
  ready: number;
  /** What the branch has to act on now: price it, print it, finish it. */
  waiting: number;
}

/**
 * Open jobs per stage — **one branch**, or every branch the reader sees the
 * queue of (the home tile). Overdue jobs are swept first, so a job past its
 * payment window is not counted as still waiting.
 */
export async function queueCounts(actor: RequestActorContext, branchId?: number): Promise<WireQueueCounts> {
  let branchIds: number[];
  if (branchId !== undefined) {
    await requireScope(actor, QUEUE_VIEW_KEY, branchId);
    branchIds = [branchId];
  } else {
    branchIds = (await queueBranches(actor)).map((b) => b.id);
  }
  await sweepOverdue();
  const m = await repo.countByStatus(branchIds);
  const n = (s: PrintJobStatus): number => m.get(s) ?? 0;
  return {
    to_price: n('awaiting_quote'),
    awaiting_payment: n('awaiting_payment'),
    queued: n('queued'),
    in_production: n('in_production'),
    ready: n('ready'),
    waiting: n('awaiting_quote') + n('queued') + n('in_production'),
  };
}

export async function listQueue(
  actor: RequestActorContext,
  branchId: number,
  statuses: PrintJobStatus[] | undefined,
  limit: number,
  offset: number,
): Promise<{ items: WireStaffPrintJob[]; total: number }> {
  await requireScope(actor, QUEUE_VIEW_KEY, branchId);
  await sweepOverdue();
  const { rows, total } = await repo.findJobs(
    { branchId, statuses, excludeDrafts: true, excludeCounter: true },
    limit,
    offset,
  );
  const seeCost = await canSeeCost(actor.userId, branchId);
  return { items: await Promise.all(rows.map((row) => staffWire(row, seeCost))), total };
}

export async function getForStaff(
  actor: RequestActorContext,
  jobId: number,
): Promise<WireStaffPrintJob> {
  const row = await requireStaffJob(actor, QUEUE_VIEW_KEY, jobId);
  return staffWire(row, await canSeeCost(actor.userId, row.branch_id));
}

/**
 * رابط ملفٍ للموظف — **ويُسجَّل بالتدقيق**: الملف قد يكون نسخة هوية، و«من فتح
 * ملف هذا الزبون؟» سؤالٌ يُطرح حين يُسأل.
 */
export async function staffFileLink(
  actor: RequestActorContext,
  jobId: number,
  fileId: number,
): Promise<{ url: string }> {
  await requireStaffJob(actor, QUEUE_VIEW_KEY, jobId);
  const url = await fileLinkOf(jobId, fileId);
  await recordAudit(actor, PRINTING_AUDIT.jobFileOpen, printingTarget.job(jobId), null, {
    file_id: fileId,
  });
  return { url };
}

/**
 * **الموظف يكتب صفحات النسخة، والخادم يسعّر** (قرار 2026-09-28) — بـ`/quote`
 * نفسه، فلا نسخة ثانية من قاعدة السعر. ويُعاد التسعير ما دام لم يُدفع (أخطأ
 * العدّ؟ يصحّحه)، والمهلة تبدأ من آخر تسعير: الزبون يُمنح أيامه على السعر
 * الذي يراه الآن.
 */
export async function quoteJob(
  actor: RequestActorContext,
  jobId: number,
  input: { pages: number; label?: string | null },
): Promise<WireStaffPrintJob> {
  const row = await requireStaffJob(actor, STATUS_UPDATE_KEY, jobId);
  if (row.status !== 'awaiting_quote' && row.status !== 'awaiting_payment') {
    throw new BusinessError(409, 'This print job cannot be priced now', 'print_job_wrong_status', {
      status: row.status,
    });
  }
  requireNotAtTill(row);
  const quote = await priceJob(row.branch_id, {
    pages: input.pages,
    copies: row.copies,
    ...toSpec(row),
  });
  const settings = await printingRepo.getSettings();
  const now = new Date();
  await db.transaction(async (tx) => {
    const locked = await repo.lockJob(tx, jobId);
    if (!locked || (locked.status !== 'awaiting_quote' && locked.status !== 'awaiting_payment')) {
      throw new BusinessError(
        409,
        'This print job cannot be priced now',
        'print_job_wrong_status',
        {
          status: locked?.status ?? null,
        },
      );
    }
    requireNotAtTill(locked);
    await repo.updateJob(tx, jobId, {
      status: 'awaiting_payment',
      total_pages: input.pages,
      // Omitted ⇒ keep what was there; an empty string clears it.
      ...(input.label === undefined ? {} : { label: input.label?.trim() || null }),
      quote,
      quoted_total_syp: String(quote.total_syp),
      quoted_by: actor.userId,
      quoted_at: now,
      payment_due_at: paymentDeadline(now, settings.unpaid_timeout_days),
    });
  });
  await recordAudit(
    actor,
    PRINTING_AUDIT.jobQuote,
    printingTarget.job(jobId),
    { total_pages: row.total_pages, quoted_total_syp: num(row.quoted_total_syp) },
    { total_pages: input.pages, quoted_total_syp: quote.total_syp },
  );
  emitPrintJobEvent('priced', row);
  return staffWireFor(actor, jobId);
}

/**
 * المراحل التي يحرّكها الموظف: بدء الإنتاج · جاهز · استُلم.
 *
 * **بدء الإنتاج يفحص الدفع بنفسه** لا بالحالة وحدها: صفٌّ صار `queued` بخطأ
 * يوماً لا يجب أن يطبع مجاناً — «لا ورق ولا حبر لطلبٍ لم يُثبَّت دفعه».
 */
export async function advanceJob(
  actor: RequestActorContext,
  jobId: number,
  to: StaffStage,
): Promise<WireStaffPrintJob> {
  const row = await requireStaffJob(actor, STATUS_UPDATE_KEY, jobId);
  const now = new Date();
  await db.transaction(async (tx) => {
    const locked = await repo.lockJob(tx, jobId);
    if (!locked || !canMove(locked.status, to)) {
      throw new BusinessError(
        409,
        'This print job cannot move to that stage',
        'print_job_wrong_status',
        {
          status: locked?.status ?? null,
          to,
        },
      );
    }
    // Unpaid (or deferred) copies are handed over at the till, which collects
    // first — a pickup here would let them leave unpaid (9-ز-4).
    if (to === 'picked_up' && !canHandOver(locked.status, locked.payment_status)) {
      throw new BusinessError(409, 'This print order is paid at the till before pickup', 'print_job_pickup_unpaid', {
        payment_status: locked.payment_status,
      });
    }
    if (to === 'in_production' && !paymentSettled(locked.payment_status)) {
      throw new BusinessError(409, 'This print job is not paid', 'print_job_unpaid', {
        payment_status: locked.payment_status,
      });
    }
    // المواد تُخصم **بمعاملة بدء الطباعة نفسها** (قرار 2026-09-28): طلبٌ بدأ
    // بلا حركة لورقه يترك الرفّ أعلى من الواقع بلا أي فشل.
    const materialsCost =
      to === 'in_production' ? await consumeForJob(tx, locked, actor.userId) : null;
    await repo.updateJob(tx, jobId, {
      status: to,
      ...(to === 'in_production'
        ? {
            production_started_at: now,
            consumed_at: now,
            // A partial ready hand-over: the shelf copies' value plus the rest's paper.
            materials_cost_syp: String((materialsCost ?? 0) + (num(locked.ready_value_syp) ?? 0)),
          }
        : {}),
      ...(to === 'ready' ? { ready_at: now, pickup_code: await issuePickupCode(tx, locked.branch_id, now) } : {}),
      ...(to === 'picked_up' ? { picked_up_at: now, closed_at: now } : {}),
    });
  });
  await applyFileRetention(jobId, to, now);
  await recordAudit(
    actor,
    PRINTING_AUDIT.jobStage,
    printingTarget.job(jobId),
    { status: row.status },
    { status: to },
  );
  emitPrintJobEvent(eventForStage(to), row);
  return staffWireFor(actor, jobId);
}

// ── الطباعة الفورية أمراً (9-ح-1) ────────────────────────────────────────

export interface CounterJobInput {
  branchId: number;
  spec: { paperSizeId: number; colorModeId: number; sidesId: number; bindingId: number; coverId: number };
  pages: number;
  copies: number;
  label: string | null;
  /** A registered customer — or [contactName] typed at the counter — or neither (walk-in). */
  customerId: number | null;
  contactName: string | null;
  contactPhone: string | null;
}

/**
 * A print for the customer standing at the till — **an order like any other**
 * (9-ح-1), so it is in the record, the reports and the customer's history.
 * Priced now, joins the basket as a `print_job` line, and is printed, handed
 * over and its paper deducted as the invoice settles (`print-till.settle`).
 * It never sits on the production board: the cashier prints it.
 */
export async function createCounterJob(
  actor: RequestActorContext,
  input: CounterJobInput,
): Promise<{ id: number; kind: 'print_job'; number: string | null; total_syp: number }> {
  if (input.customerId !== null && !(await repo.findCustomer(input.customerId))) {
    throw new NotFoundError('Customer not found');
  }
  await assertPrintableSpec(input.branchId, input.spec);
  const quote = await priceJob(input.branchId, { ...input.spec, pages: input.pages, copies: input.copies });
  const now = new Date();
  const settings = await printingRepo.getSettings();
  const row = await db.transaction(async (tx) => {
    const code = await repo.findBranchCode(tx, input.branchId);
    const { number, sequence } = await issueNumber(tx, 'print_job', branchPrefix(code, input.branchId));
    return repo.insertJob({
      branch_id: input.branchId,
      customer_id: input.customerId,
      source: 'counter',
      contact_name: input.customerId === null ? input.contactName?.trim() || null : null,
      contact_phone: input.customerId === null ? input.contactPhone?.trim() || null : null,
      number,
      sequence,
      status: 'awaiting_payment',
      paper_size_id: input.spec.paperSizeId,
      color_mode_id: input.spec.colorModeId,
      sides_id: input.spec.sidesId,
      binding_id: input.spec.bindingId,
      cover_id: input.spec.coverId,
      copies: input.copies,
      total_pages: input.pages,
      label: input.label?.trim() || null,
      quote,
      quoted_total_syp: quote.total_syp.toFixed(2),
      quoted_at: now,
      submitted_at: now,
      // Swept like any unpaid order if it never reaches a basket.
      payment_due_at: paymentDeadline(now, settings.unpaid_timeout_days),
    }, tx);
  });
  await recordAudit(actor, PRINTING_AUDIT.jobStage, printingTarget.job(row.id), null, {
    status: 'awaiting_payment',
    source: 'counter',
  });
  emitPrintJobEvent('priced', row);
  return { id: row.id, kind: 'print_job', number: row.number, total_syp: quote.total_syp };
}

/** Who a counter print may be for — accounts first, then typed names. */
export async function findContacts(q: string) {
  return repo.findContacts(q.trim());
}

/** The pickup code — inside the transaction that makes the job ready. */
async function issuePickupCode(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], branchId: number, at: Date): Promise<string> {
  const code = await repo.findBranchCode(tx, branchId);
  return (await issueNumber(tx, 'pickup', branchPrefix(code, branchId), at)).number;
}

/**
 * Ready jobs a till can hand over, matched by **any** of what the customer
 * brings (9-ز-2): the pickup code written on the copies, the order number,
 * the barcode (which carries the order number), or their phone or name.
 * Ready jobs only — a code that came round again matches today's open job, and
 * when two still match both are returned, never one picked for the cashier.
 */
export async function lookupForPickup(
  actor: RequestActorContext,
  branchId: number,
  q: string,
  saleId: number | null = null,
): Promise<(WireStaffPrintJob & { till_action: TillAction; other_sale_id: number | null })[]> {
  const [queue, till] = await Promise.all([
    holdsPermissionAt(actor.userId, QUEUE_VIEW_KEY, branchId),
    holdsPermissionAt(actor.userId, 'sales.sell', branchId),
  ]);
  if (!queue && !till) {
    throw new BusinessError(403, 'No printing permission at this branch', 'print_scope_denied', {
      branch_id: branchId,
    });
  }
  const rows = await repo.findForTill(branchId, q.trim());
  const seeCost = await canSeeCost(actor.userId, branchId);
  return Promise.all(
    rows.map(async (row) => {
      const action = tillActionFor(row, saleId);
      return {
        ...(await staffWire(row, seeCost)),
        till_action: action,
        other_sale_id: action === 'in_other_sale' ? row.sale_id : null,
      };
    }),
  );
}

/**
 * The cashier hands a **paid** ready order over (9-ز-4) — found at the till by
 * its pickup code. Either key at the job's branch: the production clerk who
 * works the board, or the cashier who stands at the counter.
 */
export async function handOver(actor: RequestActorContext, jobId: number): Promise<WireStaffPrintJob> {
  const row = await repo.findJob(jobId);
  if (!row || row.status === 'draft') throw new NotFoundError('Print order not found');
  const [board, till] = await Promise.all([
    holdsPermissionAt(actor.userId, STATUS_UPDATE_KEY, row.branch_id),
    holdsPermissionAt(actor.userId, 'sales.sell', row.branch_id),
  ]);
  if (!board && !till) {
    throw new BusinessError(403, 'No printing permission at this branch', 'print_scope_denied', {
      branch_id: row.branch_id,
    });
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    const locked = await repo.lockJob(tx, jobId);
    if (!locked || !canHandOver(locked.status, locked.payment_status)) {
      throw new BusinessError(409, 'This print order is paid at the till before pickup', 'print_job_pickup_unpaid', {
        status: locked?.status ?? null,
        payment_status: locked?.payment_status ?? null,
      });
    }
    await repo.updateJob(tx, jobId, { status: 'picked_up', picked_up_at: now, closed_at: now });
  });
  await applyFileRetention(jobId, 'picked_up', now);
  await recordAudit(actor, PRINTING_AUDIT.jobStage, printingTarget.job(jobId), { status: row.status }, {
    status: 'picked_up',
  });
  emitPrintJobEvent('picked_up', row);
  return staffWireFor(actor, jobId);
}

/**
 * Hand a paid order over from the ready shelf (`finance_ledger.md` §٤) — the
 * step «start printing» would take, skipped: the order goes straight to
 * `ready`, the copies come off the shelf and their value is the order's cost.
 * Same gate as printing: queued and paid (or deferred).
 */
export async function fulfillFromReady(
  actor: RequestActorContext,
  jobId: number,
  readyCopyId: number,
  copies?: number,
): Promise<WireStaffPrintJob> {
  const row = await requireStaffJob(actor, STATUS_UPDATE_KEY, jobId);
  const now = new Date();
  let taken = '';
  let partial = false;
  await db.transaction(async (tx) => {
    const locked = await repo.lockJob(tx, jobId);
    if (!locked || locked.status !== 'queued') {
      throw new BusinessError(409, 'This print job cannot move to that stage', 'print_job_wrong_status', {
        status: locked?.status ?? null,
        to: 'ready',
      });
    }
    if (!paymentSettled(locked.payment_status)) {
      throw new BusinessError(409, 'This print job is not paid', 'print_job_unpaid', {
        payment_status: locked.payment_status,
      });
    }
    if (locked.from_ready_copies > 0) {
      throw new BusinessError(409, 'Part of this order already came off the ready shelf', 'print_ready_already_taken');
    }
    // All the order's copies — or fewer (9-ز-5): the shelf has 3 of 5, the
    // three are handed over and the order stays queued for the other two.
    const take = copies ?? locked.copies;
    if (take < 1 || take > locked.copies) {
      throw new BusinessError(422, 'Take between one copy and the whole order', 'print_ready_take_invalid', {
        copies: locked.copies,
      });
    }
    const { value, number } = await takeReadyForJob(tx, {
      copyId: readyCopyId,
      branchId: locked.branch_id,
      copies: take,
      jobId,
      saleId: locked.sale_id,
      userId: actor.userId,
    });
    taken = number;
    partial = take < locked.copies;
    await repo.updateJob(
      tx,
      jobId,
      partial
        ? { fulfilled_from_ready_id: readyCopyId, from_ready_copies: take, ready_value_syp: String(value) }
        : {
            status: 'ready',
            production_started_at: now,
            consumed_at: now,
            ready_at: now,
            pickup_code: await issuePickupCode(tx, locked.branch_id, now),
            materials_cost_syp: String(value),
            fulfilled_from_ready_id: readyCopyId,
            from_ready_copies: take,
          },
    );
  });
  if (!partial) await applyFileRetention(jobId, 'ready', now);
  await recordAudit(actor, PRINTING_AUDIT.jobStage, printingTarget.job(jobId), { status: row.status }, {
    status: partial ? row.status : 'ready',
    from_ready: taken,
  });
  if (!partial) emitPrintJobEvent('ready', row);
  return staffWireFor(actor, jobId);
}

/** الفرع يرفض طلباً قبل الدفع (ملفٌ لا يُطبع، رابطٌ مغلق) — **والسبب يراه الزبون**. */
export async function cancelByStaff(
  actor: RequestActorContext,
  jobId: number,
  reason: string,
): Promise<WireStaffPrintJob> {
  const row = await requireStaffJob(actor, STATUS_UPDATE_KEY, jobId);
  if (row.status !== 'awaiting_quote' && row.status !== 'awaiting_payment') {
    throw new BusinessError(
      409,
      'This print job can no longer be cancelled',
      'print_job_not_cancellable',
      {
        status: row.status,
      },
    );
  }
  await closeJob(jobId, 'cancelled', reason.trim(), actor.userId);
  await recordAudit(
    actor,
    PRINTING_AUDIT.jobCancel,
    printingTarget.job(jobId),
    { status: row.status },
    {
      status: 'cancelled',
      reason: reason.trim(),
    },
  );
  return staffWireFor(actor, jobId);
}

/**
 * **الطباعة قبل الدفع — بموافقة صلاحية** (قرار 2026-09-24: زبونٌ موثوق أو
 * جملة). الطلب يدخل الطابور والدَّين يبقى قائماً: يُقبض لاحقاً بالصندوق كأي
 * طلب (`isPayable` يقبل المؤجَّل بأي مرحلة). **والسبب إلزامي ويُسجَّل باسم
 * صاحبه** — دَينٌ بلا اسمٍ لا يُطالَب به أحد.
 */
export async function deferPayment(
  actor: RequestActorContext,
  jobId: number,
  reason: string,
): Promise<WireStaffPrintJob> {
  const row = await requireStaffJob(actor, DEFER_KEY, jobId);
  const now = new Date();
  await db.transaction(async (tx) => {
    const locked = await repo.lockJob(tx, jobId);
    if (!locked || locked.status !== 'awaiting_payment' || locked.payment_status !== 'unpaid') {
      throw new BusinessError(
        409,
        'Only a priced, unpaid print order can be deferred',
        'print_job_wrong_status',
        {
          status: locked?.status ?? null,
        },
      );
    }
    requireNotAtTill(locked);
    await repo.updateJob(tx, jobId, {
      status: 'queued',
      payment_status: 'deferred',
      deferred_by: actor.userId,
      deferred_at: now,
      deferred_reason: reason.trim(),
      payment_due_at: null,
    });
  });
  await recordAudit(
    actor,
    PRINTING_AUDIT.jobDefer,
    printingTarget.job(jobId),
    { status: row.status, payment_status: row.payment_status },
    { status: 'queued', payment_status: 'deferred', reason: reason.trim() },
  );
  emitPrintJobEvent('deferred', row);
  return staffWireFor(actor, jobId);
}

// ── الإغلاق والمهلة ─────────────────────────────────────────────────────────

async function closeJob(
  jobId: number,
  status: 'cancelled' | 'expired',
  reason: string | null,
  userId: number | null,
): Promise<void> {
  const now = new Date();
  const closed = await db.transaction(async (tx) => {
    const locked = await repo.lockJob(tx, jobId);
    if (!locked) throw new NotFoundError('Print job not found');
    const allowed =
      status === 'expired'
        ? locked.status === 'awaiting_payment'
        : canMove(locked.status, 'cancelled');
    if (!allowed) {
      throw new BusinessError(
        409,
        'This print job can no longer be cancelled',
        'print_job_not_cancellable',
        {
          status: locked.status,
        },
      );
    }
    requireNotAtTill(locked);
    await repo.updateJob(tx, jobId, {
      status,
      cancel_reason: reason,
      cancelled_by: userId,
      payment_due_at: null,
      closed_at: now,
    });
    return locked;
  });
  await applyFileRetention(jobId, status, now);
  emitPrintJobEvent(status, closed);
}

/**
 * يُسقط الطلبات المسعَّرة التي مرّت مهلتها — **كسلاً عند القراءة** (نفس نمط
 * الطلبات): من ينظر للطابور هو من يصحّحه، ولا جدولة ثانية تعمل على كل جهاز.
 * والقفل بـ`closeJob` يمنع جهازين من إسقاط الطلب نفسه مرتين.
 */
export async function sweepOverdue(now: Date = new Date()): Promise<number> {
  const due = await repo.findOverdueJobs(now, 50);
  let closed = 0;
  for (const job of due) {
    if (!isOverdue(job.status, job.payment_due_at, now)) continue;
    try {
      await closeJob(job.id, 'expired', null, null);
      closed += 1;
    } catch {
      // سباقٌ مع دفعٍ أو كنسٍ آخر يجري الآن — أُغلق بطريقٍ آخر، ولا شيء ليُصلَح.
    }
  }
  return closed;
}
