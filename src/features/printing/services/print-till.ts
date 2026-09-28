import { and, eq } from 'drizzle-orm';
import { BusinessError } from '../../../core/http/api-error.js';
import {
  registerServiceLineHandler,
  type ServiceExec,
  type ServiceLineHandler,
  type ServiceLineQuote,
} from '../../../core/till/service-line-port.js';
import * as printingRepo from '../repositories/printing.repository.js';
import * as repo from '../repositories/print-jobs.repository.js';
import { printJobsTable, type PrintJobRow } from '../schemas/print-jobs.schema.js';
import { isPayable, paymentDeadline, statusAfterPayment } from './job-rules.js';

/**
 * طلب الطباعة **سطراً بفاتورة الصندوق** (قرار 2026-09-28: درجٌ واحد، رقم فاتورة
 * واحد، تقارير موحّدة). الصندوق يملك المال؛ وهذا الملف يقول له كم، ويسمع منه
 * متى أُضيف الطلب ومتى أُزيل ومتى سُدِّد — **بمعاملة الصندوق نفسها** عند السداد.
 */

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** «٥٢» معرّفٌ، و«BR1-P-2026-000052» رقمٌ كما يقرؤه الزبون من شاشته. */
async function findByReference(
  reference: string,
  branchId: number,
): Promise<PrintJobRow | undefined> {
  const ref = reference.trim();
  if (/^\d+$/.test(ref)) return repo.findJob(Number(ref));
  return repo.findJobByNumber(branchId, ref.toUpperCase());
}

async function resolve(input: {
  reference: string;
  branchId: number;
  saleId: number;
}): Promise<ServiceLineQuote> {
  const job = await findByReference(input.reference, input.branchId);
  if (!job || job.status === 'draft') {
    throw new BusinessError(404, 'No print order with this number', 'print_job_not_found', {
      reference: input.reference,
    });
  }
  // طلبٌ يُطبع بفرعٍ ويُقبض بآخر: الدرج هنا والورق هناك، وتقارير الفرعين تكذبان معاً.
  if (job.branch_id !== input.branchId) {
    throw new BusinessError(
      409,
      'This print order belongs to another branch',
      'print_job_other_branch',
      {
        branch_id: job.branch_id,
      },
    );
  }
  const amount = num(job.quoted_total_syp);
  if (!isPayable(job.status, job.payment_status) || amount === null) {
    throw new BusinessError(409, 'This print order cannot be paid now', 'print_job_not_payable', {
      status: job.status,
      payment_status: job.payment_status,
    });
  }
  // بسلّةٍ أخرى مفتوحة: قبضُه هنا أيضاً يدفعه الزبون مرتين.
  if (job.sale_id !== null && job.sale_id !== input.saleId) {
    throw new BusinessError(
      409,
      'This print order is already at the till',
      'print_job_in_other_sale',
      {
        sale_id: job.sale_id,
      },
    );
  }
  return {
    refId: job.id,
    nameAr: `خدمة طباعة — ${job.number ?? job.id}`,
    sku: job.number ?? String(job.id),
    amountSyp: amount,
    taxPercent: 0,
    customerId: job.customer_id,
  };
}

/** عند الصندوق: **المهلة تتوقف** — الزبون واقفٌ يدفع، وكنسٌ يُسقط طلبه الآن يقبض ثمن طلبٍ منتهٍ. */
async function attach(exec: ServiceExec, refId: number, saleId: number): Promise<void> {
  await exec
    .update(printJobsTable)
    .set({ sale_id: saleId, payment_due_at: null, updated_at: new Date() })
    .where(eq(printJobsTable.id, refId));
}

/**
 * أُزيل من السلّة أو أُلغيت السلّة: الطلب يعود لانتظاره **بمهلة جديدة** (نفس
 * قاعدة طلب الاستلام) — تركُه مربوطاً بسلّةٍ ميتة يوقف مهلته للأبد.
 */
async function detach(exec: ServiceExec, refId: number, saleId: number): Promise<void> {
  const [job] = await exec
    .select()
    .from(printJobsTable)
    .where(and(eq(printJobsTable.id, refId), eq(printJobsTable.sale_id, saleId)))
    .limit(1);
  if (!job || job.payment_status === 'paid') return;
  const settings = await printingRepo.getSettings();
  await exec
    .update(printJobsTable)
    .set({
      sale_id: null,
      payment_due_at:
        job.status === 'awaiting_payment'
          ? paymentDeadline(new Date(), settings.unpaid_timeout_days)
          : null,
      updated_at: new Date(),
    })
    .where(eq(printJobsTable.id, refId));
}

/**
 * سُدِّدت الفاتورة: **الدفع مثبَّت، والطلب يدخل الطابور** — بمعاملة الفاتورة.
 * والرفض هنا يُسقط الفاتورة كلها: طلبٌ أُلغي منذ أُضيف لا يُقبض ثمنه.
 */
async function settle(exec: ServiceExec, refId: number, saleId: number): Promise<void> {
  const [job] = await exec
    .select()
    .from(printJobsTable)
    .where(eq(printJobsTable.id, refId))
    .for('update')
    .limit(1);
  if (!job || job.sale_id !== saleId || !isPayable(job.status, job.payment_status)) {
    throw new BusinessError(409, 'This print order cannot be paid now', 'print_job_not_payable', {
      status: job?.status ?? null,
      payment_status: job?.payment_status ?? null,
    });
  }
  const now = new Date();
  await exec
    .update(printJobsTable)
    .set({
      payment_status: 'paid',
      status: statusAfterPayment(job.status),
      paid_at: now,
      payment_due_at: null,
      updated_at: now,
    })
    .where(eq(printJobsTable.id, refId));
}

const handler: ServiceLineHandler = { kind: 'print_job', resolve, attach, detach, settle };

/** يُستدعى من `buildApp()` — بلا تسجيل يرمي الصندوق عند أول سطر طباعة (لا دفعٌ صامت). */
export function installPrintServiceLine(): void {
  registerServiceLineHandler(handler);
}
