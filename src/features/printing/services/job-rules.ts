import type { PrintJobStatus, PrintPaymentStatus } from '../schemas/print-jobs.schema.js';

/**
 * قواعد طلب الطباعة — دالّات صافية.
 *
 * **كل جواب خاطئ هنا ورقٌ وحبرٌ لطلبٍ لم يُدفع، أو زبونٌ يصل لطلبٍ لم يبدأ.**
 * ولا شيء يفشل: الشاشة تعرض حالةً معقولة، والطابعة وحدها تعرف.
 */

/**
 * ما يمكن أن يصير إليه الطلب الآن. تُرسَل مع الردّ فتُبنى الأزرار منها — آلة
 * حالاتٍ ثانية بالعميل تنحرف أول تعديل، وتعرض زرّاً يرفضه الخادم.
 */
export function nextStates(status: PrintJobStatus): PrintJobStatus[] {
  switch (status) {
    case 'draft':
      return ['awaiting_quote', 'cancelled'];
    case 'awaiting_quote':
      return ['awaiting_payment', 'cancelled'];
    case 'awaiting_payment':
      // `queued` بالدفع وحده (9-ج-3)، و`expired` بالمهلة وحدها.
      return ['queued', 'cancelled', 'expired'];
    // **بعد الدفع لا إلغاء من هنا**: المال خرج من يد الزبون، وإلغاءٌ بلا ردّ
    // مالٍ يترك الدرج مختلفاً عن الطلبات. طريقه مرتجع الصندوق (9-ج-3).
    case 'queued':
      return ['in_production'];
    case 'in_production':
      return ['ready'];
    case 'ready':
      return ['picked_up'];
    case 'picked_up':
    case 'cancelled':
    case 'expired':
      return [];
  }
}

export function canMove(from: PrintJobStatus, to: PrintJobStatus): boolean {
  return nextStates(from).includes(to);
}

/** المراحل التي يحرّكها الموظف بيده — الباقي بالتسعير والدفع والمهلة والإلغاء. */
export const STAFF_STAGES = ['in_production', 'ready', 'picked_up'] as const;
export type StaffStage = (typeof STAFF_STAGES)[number];

/**
 * **بوابة الإنتاج** (قرار 2026-09-24): لا يبدأ طلبٌ بلا دفعٍ مثبَّت — مدفوع أو
 * مؤجَّل بموافقة. تُفحص هنا **أيضاً** لا بالحالة وحدها: صفٌّ صار `queued`
 * بخطأ يوماً لا يجب أن يطبع مجاناً.
 */
export function paymentSettled(payment: PrintPaymentStatus): boolean {
  return payment === 'paid' || payment === 'deferred';
}

/**
 * هل يُقبض ثمن هذا الطلب الآن بالصندوق:
 * - المسعَّر المنتظِر للدفع؛
 * - **والمؤجَّل** بأي مرحلة قبل الإغلاق بالإلغاء — طُبع قبل الدفع بموافقة، ودَينه
 *   ما زال قائماً حتى يُسدَّد (وقد يُسدَّد عند الاستلام).
 * والمدفوع لا يُقبض مرتين.
 */
export function isPayable(status: PrintJobStatus, payment: PrintPaymentStatus): boolean {
  if (payment === 'paid') return false;
  if (status === 'awaiting_payment') return payment === 'unpaid';
  if (payment !== 'deferred') return false;
  return (
    status === 'queued' ||
    status === 'in_production' ||
    status === 'ready' ||
    status === 'picked_up'
  );
}

/** بعد السداد: المنتظِر يدخل الطابور، والمؤجَّل يبقى بمرحلته — الدفع وحده يتغيّر. */
export function statusAfterPayment(status: PrintJobStatus): PrintJobStatus {
  if (status === 'awaiting_payment') return 'queued';
  // Paid at the till while ready (printed before payment, 9-ز-4): the customer
  // is standing at the counter with the copies — paying is the pickup.
  if (status === 'ready') return 'picked_up';
  return status;
}

/**
 * The copies leave the counter only paid (9-ز-4). «Deferred» printed before
 * payment — the money is still owed, so the till collects it first.
 */
export function canHandOver(status: PrintJobStatus, payment: PrintPaymentStatus): boolean {
  return status === 'ready' && payment === 'paid';
}

/** ما يستطيع الزبون تعديله: المواصفة والملفات والروابط — في المسودة وحدها. */
export function isEditable(status: PrintJobStatus): boolean {
  return status === 'draft';
}

/** الزبون يلغي ما لم يُدفع بعد. */
export function customerCanCancel(status: PrintJobStatus): boolean {
  return status === 'draft' || status === 'awaiting_quote' || status === 'awaiting_payment';
}

export function isClosed(status: PrintJobStatus): boolean {
  return status === 'picked_up' || status === 'cancelled' || status === 'expired';
}

export interface SubmitInput {
  readyFiles: number;
  pendingFiles: number;
  /** ملفٌ رُفض نوعه أو حُذف لانتهاء مدّته — ما زال بالطلب. */
  unusableFiles: number;
  links: number;
}

export type SubmitProblem = 'nothing_to_print' | 'files_uploading' | 'files_unusable';

/**
 * هل تصلح المسودة للإرسال. **ملفٌ لم يكتمل رفعه يمنع الإرسال** لا يُتجاهَل:
 * الموظف كان سيسعّر طلباً ناقصاً والزبون يظنّه كاملاً.
 */
export function submitProblem(input: SubmitInput): SubmitProblem | null {
  if (input.pendingFiles > 0) return 'files_uploading';
  if (input.unusableFiles > 0) return 'files_unusable';
  if (input.readyFiles + input.links === 0) return 'nothing_to_print';
  return null;
}

/**
 * متى يسقط الطلب المسعَّر. **صفر = بلا مهلة** لا «يسقط فوراً» (نفس قاعدة حجز
 * الطلبات): الثانية تُلغي كل طلبٍ لحظة تسعيره.
 */
export function paymentDeadline(quotedAt: Date, days: number): Date | null {
  if (days <= 0) return null;
  return new Date(quotedAt.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isOverdue(status: PrintJobStatus, dueAt: Date | null, now: Date): boolean {
  return status === 'awaiting_payment' && dueAt !== null && now.getTime() >= dueAt.getTime();
}

/** كم بقي بالساعات — «يسقط خلال ٥ ساعات» أصدق من تاريخٍ يُحسب ذهنياً. */
export function hoursLeft(dueAt: Date | null, now: Date): number | null {
  if (dueAt === null) return null;
  const ms = dueAt.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / (60 * 60 * 1000));
}

/** بعد الإلغاء أو السقوط: أسبوعٌ ليُعاد الطلب بلا رفعٍ جديد، ثم تُحذف الملفات. */
export const CLOSED_FILE_RETENTION_DAYS = 7;

/**
 * متى تُحذف ملفات الطلب بحالته — `null` = تبقى (الطلب حيّ، والإنتاج يحتاجها).
 * **والاستلام يعدّ من يومه** (`file_retention_days`، ٣٠ — «أعد الطباعة» شهراً).
 */
export function fileExpiryFor(
  status: PrintJobStatus,
  at: Date,
  retentionDays: number,
): Date | null | 'unchanged' {
  const days = (n: number) => new Date(at.getTime() + n * 24 * 60 * 60 * 1000);
  switch (status) {
    // المسودة: الملف الجاهز غير المُطالَب به يحمل مهلة `core/media` (٧ أيام).
    case 'draft':
      return 'unchanged';
    case 'picked_up':
      return days(retentionDays);
    case 'cancelled':
    case 'expired':
      return days(CLOSED_FILE_RETENTION_DAYS);
    default:
      return null;
  }
}

/** `MZ-P-2026-000001` — حرف `P` يفصل الطباعة عن الفواتير (بلا حرف) والطلبات (`O`). */
export function formatJobNumber(prefix: string, year: number, sequence: number): string {
  const clean = prefix.trim().toUpperCase().slice(0, 6) || 'SL';
  return `${clean}-P-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * رابطٌ يُطبع: `https` وحدها ومضيفٌ حقيقي. `http` يُفتح على جهاز المحل بلا
 * تشفير، و`file:`/`javascript:` ليسا مستندات. **والخادم لا يجلبه أبداً**.
 */
export function isPrintableLink(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname.includes('.') &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * What the cashier can do with an order found at the till (9-ح-2 audit) —
 * **decided here, sent with the row**, so the till never re-derives payment
 * rules. Every order the search finds is shown with its answer, the ones that
 * cannot be acted on included: an order the till cannot see is an order the
 * customer is told does not exist.
 */
export const TILL_ACTIONS = [
  'hand_over', // ready and paid — hand it over, no line
  'add', // owed (to pay before printing, a ready unpaid order, a debt) — a line on this invoice
  'in_this_sale', // already on this invoice
  'in_other_sale', // on another open invoice — move it here
  'not_priced', // not priced yet — nothing to collect
  'paid_in_work', // paid, still printing — nothing to do at the till
  'closed', // picked up, cancelled or expired
] as const;
export type TillAction = (typeof TILL_ACTIONS)[number];

export function tillActionFor(
  job: { status: PrintJobStatus; payment_status: PrintPaymentStatus; sale_id: number | null; quoted_total_syp: string | null },
  saleId: number | null,
): TillAction {
  // A paid order keeps the invoice that paid it — history, not a basket holding it.
  if (job.sale_id !== null && job.payment_status !== 'paid') {
    return job.sale_id === saleId ? 'in_this_sale' : 'in_other_sale';
  }
  if (canHandOver(job.status, job.payment_status)) return 'hand_over';
  // Before «closed»: a deferred order picked up still owes its money.
  if (isPayable(job.status, job.payment_status) && job.quoted_total_syp !== null) return 'add';
  if (isClosed(job.status)) return 'closed';
  if (job.status === 'awaiting_quote') return 'not_priced';
  return 'paid_in_work';
}
