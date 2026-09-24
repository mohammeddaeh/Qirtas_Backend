import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import {
  addLineBodySchema,
  approveDiscountBodySchema,
  capBodySchema,
  creditLimitBodySchema,
  discountBodySchema,
  discountCheckQuerySchema,
  heldBodySchema,
  ledgerBodySchema,
  lineQtyBodySchema,
  openSaleBodySchema,
  openSalesQuerySchema,
  payBodySchema,
  salesQuerySchema,
  sellableItemsQuerySchema,
} from '../dtos/sales.dto.js';
import * as controller from '../controllers/sales.controller.js';

/**
 * `/api/v1/sales/*` — نقطة البيع (`orders_delivery.md` §الفوترة، `store_system.md` §٦).
 *
 * **مفتاحان للبيع لا واحد**: `sales.sell` يفتح سلّة ويسدّدها (الكاشير)،
 * و`sales.view` يقرأ الفواتير (المحاسب لا يبيع، والكاشير لا يتصفّح مبيعات
 * الفروع). ومفتاحٌ واحد كان سيمنح من يحتاج التقرير القدرةَ على البيع.
 *
 * **والسقوف وحدود الآجل تحت `sales.manage`**: كم يخصم الدور وكم يُقرَض الزبون
 * قراران ماليان لا يملكهما من يقف على الصندوق.
 */
export const salesRouter: Router = Router();

const canSell = () =>
  requirePermission('sales.sell', {
    display: { ar: 'البيع بنقطة البيع', en: 'Sell at the Till' },
  });

const canView = () =>
  requirePermission('sales.view', {
    display: { ar: 'عرض المبيعات', en: 'View Sales' },
  });

const canManage = () =>
  requirePermission('sales.manage', {
    display: { ar: 'إدارة سقوف الخصم والآجل', en: 'Manage Discount & Credit Limits' },
    sensitive: true,
  });

// ── السلّة ──────────────────────────────────────────────────────────────────

salesRouter.post('/', canSell(), validate(openSaleBodySchema, 'body'), asyncHandler(controller.open));

/** سلّات الكاشير المفتوحة — قبل `/:id` وإلا ابتلعها معرّفٌ اسمه «open». */
salesRouter.get(
  '/open',
  canSell(),
  validate(openSalesQuerySchema, 'query'),
  asyncHandler(controller.listOpen),
);

/** «هل أستطيع هذا الخصم؟» — يُسأل **قبل** أن يَعِد الكاشير الزبون بشيء. */
salesRouter.get(
  '/discount-check',
  canSell(),
  validate(discountCheckQuerySchema, 'query'),
  asyncHandler(controller.checkDiscount),
);

/** ما يصلح لسطر بيع — قبل `/:id` وإلا ابتلعه معرّفٌ اسمه «items». */
salesRouter.get(
  '/items',
  canSell(),
  validate(sellableItemsQuerySchema, 'query'),
  asyncHandler(controller.searchItems),
);

salesRouter.get('/caps', canView(), asyncHandler(controller.getCaps));

salesRouter.put('/caps', canManage(), validate(capBodySchema, 'body'), asyncHandler(controller.setCap));

salesRouter.get('/', canView(), validate(salesQuerySchema, 'query'), asyncHandler(controller.list));

salesRouter.get('/:id', canView(), validate(idParamsSchema, 'params'), asyncHandler(controller.getOne));

salesRouter.post(
  '/:id/lines',
  canSell(),
  validate(idParamsSchema, 'params'),
  validate(addLineBodySchema, 'body'),
  asyncHandler(controller.addLine),
);

salesRouter.patch(
  '/:id/lines/:lineId',
  canSell(),
  validate(lineQtyBodySchema, 'body'),
  asyncHandler(controller.setLineQty),
);

salesRouter.delete('/:id/lines/:lineId', canSell(), asyncHandler(controller.removeLine));

salesRouter.post(
  '/:id/hold',
  canSell(),
  validate(idParamsSchema, 'params'),
  validate(heldBodySchema, 'body'),
  asyncHandler(controller.setHeld),
);

salesRouter.post(
  '/:id/void',
  canSell(),
  validate(idParamsSchema, 'params'),
  asyncHandler(controller.voidSale),
);

salesRouter.post(
  '/:id/discount',
  canSell(),
  validate(idParamsSchema, 'params'),
  validate(discountBodySchema, 'body'),
  asyncHandler(controller.setDiscount),
);

/**
 * الموافقة على تجاوز السقف — **بريد المدير وكلمة مروره على جهاز الكاشير**،
 * ولا جلسة تُفتح له. حارسها `sales.sell` لأن الطالب هو الكاشير؛ والمُوافِق
 * يُفحص بسقفه لا بمفتاحه.
 */
salesRouter.post(
  '/:id/discount/approve',
  canSell(),
  validate(idParamsSchema, 'params'),
  validate(approveDiscountBodySchema, 'body'),
  asyncHandler(controller.approveDiscount),
);

salesRouter.post(
  '/:id/pay',
  canSell(),
  validate(idParamsSchema, 'params'),
  validate(payBodySchema, 'body'),
  asyncHandler(controller.pay),
);

// ── حساب الزبون ─────────────────────────────────────────────────────────────

export const customerAccountsRouter: Router = Router();

customerAccountsRouter.get(
  '/:id/account',
  canView(),
  validate(idParamsSchema, 'params'),
  asyncHandler(controller.getCustomerAccount),
);

customerAccountsRouter.put(
  '/:id/account/limit',
  canManage(),
  validate(idParamsSchema, 'params'),
  validate(creditLimitBodySchema, 'body'),
  asyncHandler(controller.setCreditLimit),
);

/** تسديد ذمّة أو إيداع رصيد — قيدٌ يُضاف، والدفتر لا يُعدَّل. */
customerAccountsRouter.post(
  '/:id/account/entries',
  canManage(),
  validate(idParamsSchema, 'params'),
  validate(ledgerBodySchema, 'body'),
  asyncHandler(controller.adjustLedger),
);
