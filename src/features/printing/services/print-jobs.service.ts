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
import * as repo from '../repositories/print-jobs.repository.js';
import type { JobFile } from '../repositories/print-jobs.repository.js';
import type { PrintOptionKind } from '../schemas/printing.schema.js';
import type {
  PrintJobRow,
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
  formatJobNumber,
  hoursLeft,
  isEditable,
  isOverdue,
  isPrintableLink,
  nextStates,
  paymentDeadline,
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
  customer_id: number;
  customer_name: string | null;
  customer_phone: string | null;
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
    repo.findCustomer(row.customer_id),
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
    customer_name: customer?.name ?? null,
    customer_phone: customer?.phone ?? null,
    status: row.status,
    next_states: nextStates(row.status),
    payment_status: row.payment_status,
    at_till: isAtTill(row),
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
  const year = now.getFullYear();
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
    const sequence = await repo.nextJobSequence(tx, row.branch_id, year);
    await repo.updateJob(tx, jobId, {
      number: formatJobNumber(branchPrefix(branch.name, branch.id), year, sequence),
      sequence,
      status: 'awaiting_quote',
      submitted_at: now,
    });
  });
  await setDocumentExpiry(
    files.map((f) => f.asset.id),
    null,
  );
  return wireJob((await repo.findJob(jobId))!);
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
    { branchId, statuses, excludeDrafts: true },
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
  input: { pages: number },
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
            materials_cost_syp: String(materialsCost ?? 0),
          }
        : {}),
      ...(to === 'ready' ? { ready_at: now } : {}),
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
  await db.transaction(async (tx) => {
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
  });
  await applyFileRetention(jobId, status, now);
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
