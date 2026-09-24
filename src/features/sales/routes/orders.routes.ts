import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requireCustomer } from '../../../core/http/require-customer.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import {
  cancelOrderBodySchema,
  cartItemBodySchema,
  cartQtyBodySchema,
  cartQuerySchema,
  checkoutBodySchema,
  myOrdersQuerySchema,
  ordersQuerySchema,
} from '../dtos/orders.dto.js';
import * as controller from '../controllers/orders.controller.js';

/**
 * السلّة والطلب — `orders_delivery.md`، `qirtas_backend/docs/rest_api.md` §28.
 *
 * **ثلاثة مسارات لا واحد**، لأن القارئ يختلف: السلّة وطلباتي للزبون بجلسته،
 * والطابور للموظف بصلاحيته. مسارٌ واحد يخدم الاثنين كان سيحتاج فرعاً داخلياً
 * يقرّر أيّهما المتصل — وأول خطأ فيه يُري زبوناً طلبات المحل كلّها.
 *
 * **ولا طريق للضيف** (قرار 2026-09-24): السلّة بالخادم تحتاج صاحباً، والحجز
 * وعدٌ باسمٍ — فمن لا حساب له يسجّل أولاً.
 */

// ── السلّة (الزبون) ─────────────────────────────────────────────────────────

export const cartRouter: Router = Router();

cartRouter.get(
  '/',
  requireCustomer,
  validate(cartQuerySchema, 'query'),
  asyncHandler(controller.getCart),
);

cartRouter.post(
  '/items',
  requireCustomer,
  validate(cartQuerySchema, 'query'),
  validate(cartItemBodySchema, 'body'),
  asyncHandler(controller.addToCart),
);

/** الكمية تُوضَع لا تُزاد — والصفر يحذف السطر. */
cartRouter.patch(
  '/items',
  requireCustomer,
  validate(cartQuerySchema, 'query'),
  validate(cartQtyBodySchema, 'body'),
  asyncHandler(controller.setCartQty),
);

cartRouter.delete(
  '/items/:variantId',
  requireCustomer,
  validate(cartQuerySchema, 'query'),
  asyncHandler(controller.removeFromCart),
);

/**
 * التأكيد — **يحجز البضاعة بمعاملة واحدة** مع إنشاء الطلب.
 *
 * والفحص يُعاد داخل القفل: بين ملء السلّة والضغط هنا قد يشتري غيره آخر قطعة.
 */
cartRouter.post(
  '/checkout',
  requireCustomer,
  validate(checkoutBodySchema, 'body'),
  asyncHandler(controller.checkout),
);

// ── طلباتي (الزبون) ─────────────────────────────────────────────────────────

export const myOrdersRouter: Router = Router();

myOrdersRouter.get(
  '/',
  requireCustomer,
  validate(myOrdersQuerySchema, 'query'),
  asyncHandler(controller.listMyOrders),
);

myOrdersRouter.get(
  '/:id',
  requireCustomer,
  validate(idParamsSchema, 'params'),
  asyncHandler(controller.getMyOrder),
);

/** الإلغاء **يحرّر الحجز فوراً**: البضاعة تعود للرفّ بنفس اللحظة. */
myOrdersRouter.post(
  '/:id/cancel',
  requireCustomer,
  validate(idParamsSchema, 'params'),
  validate(cancelOrderBodySchema, 'body'),
  asyncHandler(controller.cancelMyOrder),
);

// ── الطابور (الموظف) ────────────────────────────────────────────────────────

export const ordersRouter: Router = Router();

const canViewOrders = () =>
  requirePermission('orders.view', {
    display: { ar: 'عرض الطلبات', en: 'View Orders' },
  });

/**
 * الاستلام **يفتح سلّة صندوق** — فحارسه `sales.sell` لا `orders.view`.
 *
 * من يسلّم الطلب هو من يسدّده؛ ومفتاح القراءة كان سيجعل محاسباً يفتح سلّاتٍ
 * لا يستطيع إقفالها، فتبقى معلَّقة على الطلب بلا فاتورة.
 */
const canSell = () =>
  requirePermission('sales.sell', {
    display: { ar: 'البيع بنقطة البيع', en: 'Sell at the Till' },
  });

/** إلغاء طلب زبون قرارٌ للفرع لا قراءة — ومفتاحه مفتاح معالجة المشاكل. */
const canResolve = () =>
  requirePermission('orders.manage_issues', {
    display: { ar: 'إدارة مشاكل الطلبات', en: 'Manage Order Issues' },
  });

ordersRouter.get(
  '/',
  canViewOrders(),
  validate(ordersQuerySchema, 'query'),
  asyncHandler(controller.listOrders),
);

ordersRouter.get(
  '/:id',
  canViewOrders(),
  validate(idParamsSchema, 'params'),
  asyncHandler(controller.getOrder),
);

ordersRouter.post(
  '/:id/pickup',
  canSell(),
  validate(idParamsSchema, 'params'),
  asyncHandler(controller.startPickup),
);

ordersRouter.post(
  '/:id/cancel',
  canResolve(),
  validate(idParamsSchema, 'params'),
  validate(cancelOrderBodySchema, 'body'),
  asyncHandler(controller.cancelOrder),
);
