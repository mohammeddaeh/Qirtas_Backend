import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import {
  archiveBodySchema,
  capBodySchema,
  previewBodySchema,
  promotionBodySchema,
  promotionsQuerySchema,
  targetsQuerySchema,
} from '../dtos/promotions.dto.js';
import * as controller from '../controllers/promotions.controller.js';

/**
 * `/api/v1/promotions/*` — العروض والتخفيضات (`store_system.md` §٥).
 *
 * **مفتاحان لا واحد**: القراءة تخصّ كل من يشرح سعراً لزبون (الكاشير يُسأل
 * «لماذا هذا السعر؟»)، والكتابة قرارٌ مالي. مفتاحٌ واحد كان سيعطي من يحتاج
 * الشرح القدرةَ على تغيير الأسعار.
 *
 * **والسقوف تحت `pricing.policy`**: من يضع قواعد التسعير هو من يقرّر كم يملك
 * الفرع أن يخصم — مفتاحٌ ثالث لشاشة إعدادات واحدة يُوزَّع خطأً ولا يُلاحَظ.
 */
export const promotionsRouter: Router = Router();

const canView = () =>
  requirePermission('promotions.view', {
    display: { ar: 'عرض العروض', en: 'View Promotions' },
  });

const canEdit = () =>
  requirePermission('promotions.edit', {
    display: { ar: 'إدارة العروض', en: 'Manage Promotions' },
    sensitive: true,
  });

// الاسم يُعلَن حيث أُعلن أولاً (موديول التسعير) — إعلانه ثانيةً باسم آخر
// يجعل الصلاحية الواحدة تُقرأ صلاحيتين بشاشة الأدوار.
const canSetCaps = () => requirePermission('pricing.policy');

promotionsRouter.get('/', canView(), validate(promotionsQuerySchema, 'query'), asyncHandler(controller.list));

/** الإشارة قبل `/:id` — وإلا ابتلعها معرّفٌ اسمه «signals». */
promotionsRouter.get('/signals', canView(), asyncHandler(controller.signals));

promotionsRouter.get('/caps', canView(), asyncHandler(controller.getCaps));

// ما يصلح هدفاً لعرض — أسماءٌ للمنتقي، بحثاً بالخادم.
promotionsRouter.get(
  '/targets',
  canView(),
  validate(targetsQuerySchema, 'query'),
  asyncHandler(controller.targets),
);

promotionsRouter.put(
  '/caps',
  canSetCaps(),
  validate(capBodySchema, 'body'),
  asyncHandler(controller.setCap),
);

/**
 * **السلّة الافتراضية**: «اشترِ ٣ خذ ١» لا يظهر بسعر بند ولا بصفحة منتج، فهذا
 * هو المكان الذي يُرى فيه يعمل قبل أن يراه زبون. ويحتاج `promotions.edit` لا
 * `view`: مُجرِّب العرض هو من ينشره.
 */
promotionsRouter.post(
  '/preview',
  canEdit(),
  validate(previewBodySchema, 'body'),
  asyncHandler(controller.preview),
);

promotionsRouter.post('/', canEdit(), validate(promotionBodySchema, 'body'), asyncHandler(controller.create));

promotionsRouter.get('/:id', canView(), validate(idParamsSchema, 'params'), asyncHandler(controller.getOne));

promotionsRouter.put(
  '/:id',
  canEdit(),
  validate(idParamsSchema, 'params'),
  validate(promotionBodySchema, 'body'),
  asyncHandler(controller.update),
);

promotionsRouter.post(
  '/:id/archive',
  canEdit(),
  validate(idParamsSchema, 'params'),
  validate(archiveBodySchema, 'body'),
  asyncHandler(controller.setArchived),
);

promotionsRouter.delete(
  '/:id',
  canEdit(),
  validate(idParamsSchema, 'params'),
  asyncHandler(controller.remove),
);
