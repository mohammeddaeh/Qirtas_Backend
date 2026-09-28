import { z } from 'zod';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import { PRINT_JOB_STATUSES, type PrintJobStatus } from '../schemas/print-jobs.schema.js';
import { STAFF_STAGES } from '../services/job-rules.js';

/** طلب الطباعة — `qirtas_backend/docs/rest_api.md` §30. */

const id = z.coerce.number().int().positive();
const note = z.string().trim().max(1000).nullable().optional();

export const jobParamsSchema = z.object({ id }).strict();
export const jobFileParamsSchema = z.object({ id, fileId: id }).strict();
export const jobLinkParamsSchema = z.object({ id, linkId: id }).strict();

/**
 * حالةٌ أو عدّة مفصولة بفاصلة: `status=awaiting_quote,awaiting_payment` —
 * الطابور يريد «كل ما ينتظر عملاً» بنداء واحد، وصفحةٌ تُجمَّع من ندائين لا
 * تُصفَّح.
 */
const statusList = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v.split(',').map((s) => s.trim())))
  .refine(
    (v) => v === undefined || v.every((s) => (PRINT_JOB_STATUSES as readonly string[]).includes(s)),
    {
      message: 'Unknown status',
    },
  )
  .transform((v) => v as PrintJobStatus[] | undefined);

/** المواصفة كاملة — الأبعاد الخمسة إلزامية («بلا تجليد» خيارٌ يُختار). */
export const createJobBodySchema = z
  .object({
    branch_id: id,
    paper_size_id: id,
    color_mode_id: id,
    sides_id: id,
    binding_id: id,
    cover_id: id,
    copies: z.number().int().min(1).max(10_000),
    note,
  })
  .strict();

/** الفرع لا يتغيّر بالتعديل: الأسعار والقدرة تتبعه، ومسودةٌ بفرعٍ آخر طلبٌ آخر. */
export const updateJobBodySchema = z
  .object({
    paper_size_id: id.optional(),
    color_mode_id: id.optional(),
    sides_id: id.optional(),
    binding_id: id.optional(),
    cover_id: id.optional(),
    copies: z.number().int().min(1).max(10_000).optional(),
    note,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/**
 * ما يُعلَن قبل الرفع: الاسم والحجم **بالبايت الدقيق** — الحجم يُوقَّع في رابط
 * الرفع، والمخزن يرفض جسماً بأي حجم آخر.
 */
export const reserveFileBodySchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    bytes: z.number().int().min(1).max(2_000_000_000),
  })
  .strict();

export const addLinkBodySchema = z
  .object({
    url: z.string().trim().min(8).max(2000),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const cancelJobBodySchema = z
  .object({ reason: z.string().trim().max(500).nullable().optional() })
  .strict();

/** سبب رفض الفرع **إلزامي** — يراه الزبون، و«أُلغي» بلا سبب يُقرأ عطلاً. */
export const staffCancelBodySchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

/** سبب التأجيل **إلزامي** — دَينٌ بلا سببٍ لا يُراجَع. */
export const deferBodySchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type DeferBody = z.infer<typeof deferBodySchema>;

export const myJobsQuerySchema = paginationQuerySchema.extend({ status: statusList }).strict();

export const queueQuerySchema = paginationQuerySchema
  .extend({ branch_id: id, status: statusList })
  .strict();

/** صفحات **النسخة الواحدة** — كما عدّها الموظف من الملفات. */
export const quoteJobBodySchema = z
  .object({ pages: z.number().int().min(1).max(100_000) })
  .strict();

export const stageBodySchema = z.object({ status: z.enum(STAFF_STAGES) }).strict();

export type CreateJobBody = z.infer<typeof createJobBodySchema>;
export type UpdateJobBody = z.infer<typeof updateJobBodySchema>;
export type ReserveFileBody = z.infer<typeof reserveFileBodySchema>;
export type AddLinkBody = z.infer<typeof addLinkBodySchema>;
export type CancelJobBody = z.infer<typeof cancelJobBodySchema>;
export type StaffCancelBody = z.infer<typeof staffCancelBodySchema>;
export type MyJobsQuery = z.infer<typeof myJobsQuerySchema>;
export type QueueQuery = z.infer<typeof queueQuerySchema>;
export type QuoteJobBody = z.infer<typeof quoteJobBodySchema>;
export type StageBody = z.infer<typeof stageBodySchema>;
