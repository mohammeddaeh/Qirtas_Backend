import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requireAnyPermission, requirePermission } from '../../../core/http/require-permission.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import {
  categoriesQuerySchema,
  expenseBodySchema,
  expenseCategoryBodySchema,
  expenseCategoryPatchSchema,
  expenseReverseBodySchema,
  expensesQuerySchema,
  recurringBodySchema,
  recurringPatchSchema,
  recurringQuerySchema,
  userIdParamsSchema,
  wageBodySchema,
  wageEndBodySchema,
  wagesQuerySchema,
} from '../dtos/expenses.dto.js';
import * as controller from '../controllers/expenses.controller.js';

/**
 * المصاريف والرواتب — `/api/v1/expenses` (`finance_operations.md` §٢).
 *
 * **مفتاحان**: من يبيع يسجّل مصروفاً **من الدرج** بسقف الإخراج (قرار §٨ #٥) —
 * ويقرأ التصنيفات لذلك — و`expenses.manage` لكل ما سواه: المصروف من خارج الدرج
 * والقائمة والعكس والتصنيفات والمتكرّر والأجور. والخدمة تفحص الفرع.
 */
export const expensesRouter: Router = Router();

const canManage = () =>
  requirePermission('expenses.manage', {
    display: { ar: 'إدارة المصاريف والرواتب', en: 'Manage Expenses & Wages' },
    sensitive: true,
  });

/** A drawer expense is recorded by whoever sells; the rest needs `expenses.manage` (checked in the service). */
const canRecord = () => requireAnyPermission(['sales.sell', 'expenses.manage']);

expensesRouter.get('/categories', canRecord(), validate(categoriesQuerySchema, 'query'), asyncHandler(controller.listCategories));
expensesRouter.post('/categories', canManage(), validate(expenseCategoryBodySchema, 'body'), asyncHandler(controller.createCategory));
expensesRouter.patch(
  '/categories/:id',
  canManage(),
  validate(idParamsSchema, 'params'),
  validate(expenseCategoryPatchSchema, 'body'),
  asyncHandler(controller.updateCategory),
);

expensesRouter.get('/recurring', canManage(), validate(recurringQuerySchema, 'query'), asyncHandler(controller.listRecurring));
expensesRouter.post('/recurring', canManage(), validate(recurringBodySchema, 'body'), asyncHandler(controller.createRecurring));
expensesRouter.patch(
  '/recurring/:id',
  canManage(),
  validate(idParamsSchema, 'params'),
  validate(recurringPatchSchema, 'body'),
  asyncHandler(controller.updateRecurring),
);

expensesRouter.get('/wages', canManage(), validate(wagesQuerySchema, 'query'), asyncHandler(controller.listWages));
expensesRouter.get('/wages/:userId', canManage(), validate(userIdParamsSchema, 'params'), asyncHandler(controller.wageHistory));
expensesRouter.put(
  '/wages/:userId',
  canManage(),
  validate(userIdParamsSchema, 'params'),
  validate(wageBodySchema, 'body'),
  asyncHandler(controller.setWage),
);
expensesRouter.post(
  '/wages/:userId/end',
  canManage(),
  validate(userIdParamsSchema, 'params'),
  validate(wageEndBodySchema, 'body'),
  asyncHandler(controller.endWage),
);

expensesRouter.get('/', canManage(), validate(expensesQuerySchema, 'query'), asyncHandler(controller.list));
expensesRouter.post('/', canRecord(), validate(expenseBodySchema, 'body'), asyncHandler(controller.create));
expensesRouter.get('/:id', canManage(), validate(idParamsSchema, 'params'), asyncHandler(controller.getOne));
expensesRouter.post(
  '/:id/reverse',
  canManage(),
  validate(idParamsSchema, 'params'),
  validate(expenseReverseBodySchema, 'body'),
  asyncHandler(controller.reverse),
);
