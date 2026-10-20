import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import {
  convertPayableBodySchema,
  payPayableBodySchema,
  payableSupplierQuerySchema,
  payablesQuerySchema,
  reversePayableBodySchema,
} from '../dtos/sales.dto.js';
import * as controller from '../controllers/payables.controller.js';

/**
 * ما علينا للموردين — `/api/v1/payables` (`finance_operations.md` §٣/§٣-ب).
 *
 * **مفتاحان**: `suppliers.view` يقرأ مَن ندين له وحسابه، و`suppliers.pay`
 * (حسّاس) يدفع ويصحّح ويقلب دين الدولار إلى ليرة — والخدمة تفحص الفرع.
 * **والدفعة ليست مصروفاً**: البضاعة دخلت المخزون بقيمتها، فالدفعة تُنقص النقد وحده.
 */
export const payablesRouter: Router = Router();

const canView = () =>
  requirePermission('suppliers.view', { display: { ar: 'عرض الموردين', en: 'View Suppliers' } });

const canPay = () =>
  requirePermission('suppliers.pay', {
    display: { ar: 'الدفع للموردين', en: 'Pay Suppliers' },
    sensitive: true,
  });

payablesRouter.get('/', canView(), validate(payablesQuerySchema, 'query'), asyncHandler(controller.list));

payablesRouter.get(
  '/suppliers/:id',
  canView(),
  validate(idParamsSchema, 'params'),
  validate(payableSupplierQuerySchema, 'query'),
  asyncHandler(controller.account),
);

/** One purchase invoice's payment state — the receipt screen shows it. */
payablesRouter.get('/invoices/:id', canView(), validate(idParamsSchema, 'params'), asyncHandler(controller.invoice));

payablesRouter.post('/payments', canPay(), validate(payPayableBodySchema, 'body'), asyncHandler(controller.pay));

payablesRouter.post(
  '/payments/:id/reverse',
  canPay(),
  validate(idParamsSchema, 'params'),
  validate(reversePayableBodySchema, 'body'),
  asyncHandler(controller.reverse),
);

/** A dollar debt fixed in liras at a rate agreed with the supplier. */
payablesRouter.post(
  '/invoices/:id/convert',
  canPay(),
  validate(idParamsSchema, 'params'),
  validate(convertPayableBodySchema, 'body'),
  asyncHandler(controller.convert),
);
