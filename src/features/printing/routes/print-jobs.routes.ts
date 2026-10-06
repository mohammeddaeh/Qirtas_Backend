import { z } from 'zod';
import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requireCustomer, requireVerifiedCustomer } from '../../../core/http/require-customer.js';
import { requireAnyPermission, requirePermission } from '../../../core/http/require-permission.js';
import { validate } from '../../../core/validation/validate.js';
import {
  addLinkBodySchema,
  cancelJobBodySchema,
  createJobBodySchema,
  deferBodySchema,
  jobFileParamsSchema,
  jobLinkParamsSchema,
  jobParamsSchema,
  myJobsQuerySchema,
  pickupLookupQuerySchema,
  queueCountsQuerySchema,
  queueQuerySchema,
  quoteJobBodySchema,
  reserveFileBodySchema,
  staffCancelBodySchema,
  stageBodySchema,
  updateJobBodySchema,
} from '../dtos/print-jobs.dto.js';
import * as controller from '../controllers/print-jobs.controller.js';
import { DEFER_KEY, QUEUE_VIEW_KEY, STATUS_UPDATE_KEY } from '../services/print-jobs.service.js';

/**
 * طلب الطباعة — `qirtas_backend/docs/rest_api.md` §30.
 *
 * **مساران لا واحد** لأن القارئ يختلف (نفس قاعدة الطلبات): `/print-jobs` للزبون
 * بجلسته وطلباته وحده، و`/printing/jobs` للموظف بصلاحيته **بفرع الطلب**. مسارٌ
 * يخدم الاثنين كان سيحتاج فرعاً داخلياً يقرّر أيّهما المتصل — وأول خطأ فيه
 * يُري زبوناً ملفات غيره.
 *
 * **والكتابة للزبون الموثَّق** (`requireVerifiedCustomer`): الطلب يحمل ملفاتٍ
 * ومالاً، ومن لم يُثبت بريده لا يُحمِّل الخادم خمسين ميغابايت.
 */

// ── الزبون ──────────────────────────────────────────────────────────────────

export const myPrintJobsRouter: Router = Router();

myPrintJobsRouter.get(
  '/',
  requireCustomer,
  validate(myJobsQuerySchema, 'query'),
  asyncHandler(controller.listMine),
);

myPrintJobsRouter.post(
  '/',
  requireVerifiedCustomer,
  validate(createJobBodySchema, 'body'),
  asyncHandler(controller.create),
);

myPrintJobsRouter.get(
  '/:id',
  requireCustomer,
  validate(jobParamsSchema, 'params'),
  asyncHandler(controller.getMine),
);

myPrintJobsRouter.patch(
  '/:id',
  requireVerifiedCustomer,
  validate(jobParamsSchema, 'params'),
  validate(updateJobBodySchema, 'body'),
  asyncHandler(controller.update),
);

/** الخطوة الأولى من الرفع: حجزٌ ورابطٌ مؤقت — الملف يذهب للمخزن مباشرةً. */
myPrintJobsRouter.post(
  '/:id/files',
  requireVerifiedCustomer,
  validate(jobParamsSchema, 'params'),
  validate(reserveFileBodySchema, 'body'),
  asyncHandler(controller.reserveFile),
);

/** الخطوة الثالثة: اكتمل الرفع — الحجم والنوع **من البايتات**. */
myPrintJobsRouter.post(
  '/:id/files/:fileId/complete',
  requireVerifiedCustomer,
  validate(jobFileParamsSchema, 'params'),
  asyncHandler(controller.completeFile),
);

myPrintJobsRouter.delete(
  '/:id/files/:fileId',
  requireVerifiedCustomer,
  validate(jobFileParamsSchema, 'params'),
  asyncHandler(controller.deleteFile),
);

myPrintJobsRouter.get(
  '/:id/files/:fileId/link',
  requireCustomer,
  validate(jobFileParamsSchema, 'params'),
  asyncHandler(controller.myFileLink),
);

myPrintJobsRouter.post(
  '/:id/links',
  requireVerifiedCustomer,
  validate(jobParamsSchema, 'params'),
  validate(addLinkBodySchema, 'body'),
  asyncHandler(controller.addLink),
);

myPrintJobsRouter.delete(
  '/:id/links/:linkId',
  requireVerifiedCustomer,
  validate(jobLinkParamsSchema, 'params'),
  asyncHandler(controller.deleteLink),
);

myPrintJobsRouter.post(
  '/:id/submit',
  requireVerifiedCustomer,
  validate(jobParamsSchema, 'params'),
  asyncHandler(controller.submit),
);

/** الإلغاء متاحٌ ما لم يُدفع — وللزبون غير الموثَّق أيضاً: الخروج لا يحتاج إثباتاً. */
myPrintJobsRouter.post(
  '/:id/cancel',
  requireCustomer,
  validate(jobParamsSchema, 'params'),
  validate(cancelJobBodySchema, 'body'),
  asyncHandler(controller.cancelMine),
);

// ── الموظف ──────────────────────────────────────────────────────────────────

export const printJobsQueueRouter: Router = Router();

const canViewQueue = () =>
  requirePermission(QUEUE_VIEW_KEY, {
    display: { ar: 'عرض قائمة انتظار الطباعة', en: 'View Printing Queue' },
  });

/** التسعير وتحريك المراحل والرفض — عملٌ على الطلب لا قراءة. */
const canUpdate = () =>
  requirePermission(STATUS_UPDATE_KEY, {
    display: { ar: 'تحديث حالة الطباعة', en: 'Update Printing Status' },
  });

printJobsQueueRouter.get(
  '/',
  canViewQueue(),
  validate(queueQuerySchema, 'query'),
  asyncHandler(controller.listQueue),
);

/**
 * الفروع التي يرى القارئ طابورها — **قبل** `/:id`. موظف الإنتاج لا يملك مفتاح
 * إعداد الطباعة ولا المخزون، فقائمة الفروع التي تصل معهما لا تصله.
 */
printJobsQueueRouter.get('/branches', canViewQueue(), asyncHandler(controller.queueBranches));

/**
 * Ready jobs by what the customer brings (9-ز-2) — the queue's reader or the
 * cashier who hands the copies over. Branch scope checked in the service.
 */
printJobsQueueRouter.get(
  '/lookup',
  requireAnyPermission([QUEUE_VIEW_KEY, 'sales.sell']),
  validate(pickupLookupQuerySchema, 'query'),
  asyncHandler(controller.lookupForPickup),
);

/** Open jobs per stage — the board's stage row and the home tile. Before `/:id`. */
printJobsQueueRouter.get(
  '/counts',
  canViewQueue(),
  validate(queueCountsQuerySchema, 'query'),
  asyncHandler(controller.queueCounts),
);

printJobsQueueRouter.get(
  '/:id',
  canViewQueue(),
  validate(jobParamsSchema, 'params'),
  asyncHandler(controller.getForStaff),
);

printJobsQueueRouter.get(
  '/:id/files/:fileId/link',
  canViewQueue(),
  validate(jobFileParamsSchema, 'params'),
  asyncHandler(controller.staffFileLink),
);

printJobsQueueRouter.post(
  '/:id/quote',
  canUpdate(),
  validate(jobParamsSchema, 'params'),
  validate(quoteJobBodySchema, 'body'),
  asyncHandler(controller.quote),
);

/** A paid ready order leaves the counter (9-ز-4) — the board or the till. */
printJobsQueueRouter.post(
  '/:id/hand-over',
  requireAnyPermission([STATUS_UPDATE_KEY, 'sales.sell']),
  validate(jobParamsSchema, 'params'),
  asyncHandler(controller.handOver),
);

printJobsQueueRouter.post(
  '/:id/status',
  canUpdate(),
  validate(jobParamsSchema, 'params'),
  validate(stageBodySchema, 'body'),
  asyncHandler(controller.advance),
);

/** Hand over from the ready shelf — the stage key, like starting the print. */
printJobsQueueRouter.post(
  '/:id/fulfill-from-ready',
  canUpdate(),
  validate(jobParamsSchema, 'params'),
  validate(
    z.object({ ready_copy_id: z.number().int().positive(), copies: z.number().int().positive().optional() }).strict(),
    'body',
  ),
  asyncHandler(controller.fulfillFromReady),
);

/**
 * الطباعة قبل الدفع — مفتاحٌ حسّاس مستقل: دَينٌ يُقرَّر باسم أحد، ومن يحرّك
 * المراحل ليس بالضرورة من يمنح الائتمان. **والدفع نفسه بالصندوق**
 * (`POST /sales/:id/services`) لا هنا.
 */
printJobsQueueRouter.post(
  '/:id/defer',
  requirePermission(DEFER_KEY, {
    display: { ar: 'تأجيل دفع طلب طباعة', en: 'Defer Print Order Payment' },
    sensitive: true,
  }),
  validate(jobParamsSchema, 'params'),
  validate(deferBodySchema, 'body'),
  asyncHandler(controller.defer),
);

printJobsQueueRouter.post(
  '/:id/cancel',
  canUpdate(),
  validate(jobParamsSchema, 'params'),
  validate(staffCancelBodySchema, 'body'),
  asyncHandler(controller.cancelByStaff),
);
