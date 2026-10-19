import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import {
  closeShiftBodySchema,
  openShiftBodySchema,
  shiftCurrentQuerySchema,
  shiftMovementBodySchema,
  shiftMovementParamsSchema,
  shiftReasonBodySchema,
  shiftsQuerySchema,
} from '../dtos/sales.dto.js';
import * as controller from '../controllers/shifts.controller.js';

/**
 * `/api/v1/sales/shifts/*` — the branch's cash drawer (`docs/reference/cash_shifts.md`).
 * Mounted **before** `/api/v1/sales`, whose `/:id` would read «shifts» as an id.
 *
 * Opening, moving cash and reading the report take `sales.sell` — everyone who
 * takes money at the branch works the same drawer. **Counting and closing it
 * is its own key** (`sales.shift.close`): the print clerk who sells does not
 * close a drawer they did not count. The services check the branch.
 */
export const shiftsRouter: Router = Router();

const canSell = () =>
  requirePermission('sales.sell', {
    display: { ar: 'البيع بنقطة البيع', en: 'Sell at the Till' },
  });

const canClose = () =>
  requirePermission('sales.shift.close', {
    display: { ar: 'عدّ الدرج وإقفال الوردية', en: 'Count & Close the Drawer' },
  });

/**
 * The manager's side: every shift of their branches, approving large cash-outs,
 * reviewing flagged differences. Sensitive — it reads every drawer.
 */
const canManage = () =>
  requirePermission('sales.shift.manage', {
    display: { ar: 'إدارة ورديات الصندوق', en: 'Manage Cash Shifts' },
    sensitive: true,
  });

shiftsRouter.get('/current', canSell(), validate(shiftCurrentQuerySchema, 'query'), asyncHandler(controller.current));

shiftsRouter.post('/', canSell(), validate(openShiftBodySchema, 'body'), asyncHandler(controller.open));

shiftsRouter.get('/', canManage(), validate(shiftsQuerySchema, 'query'), asyncHandler(controller.list));

/** The line above the list — same filters, no page. Before `/:id`, which would read «summary» as an id. */
shiftsRouter.get('/summary', canManage(), validate(shiftsQuerySchema, 'query'), asyncHandler(controller.summary));

shiftsRouter.get('/:id', canSell(), validate(idParamsSchema, 'params'), asyncHandler(controller.report));

shiftsRouter.post(
  '/:id/movements',
  canSell(),
  validate(idParamsSchema, 'params'),
  validate(shiftMovementBodySchema, 'body'),
  asyncHandler(controller.addMovement),
);

/** A wrong movement is undone by its opposite — the owner, or whoever may close the drawer. */
shiftsRouter.post(
  '/:id/movements/:movementId/reverse',
  canSell(),
  validate(shiftMovementParamsSchema, 'params'),
  asyncHandler(controller.reverseMovement),
);

shiftsRouter.post(
  '/:id/close',
  canClose(),
  validate(idParamsSchema, 'params'),
  validate(closeShiftBodySchema, 'body'),
  asyncHandler(controller.close),
);

shiftsRouter.put(
  '/:id/reason',
  canSell(),
  validate(idParamsSchema, 'params'),
  validate(shiftReasonBodySchema, 'body'),
  asyncHandler(controller.setReason),
);

shiftsRouter.post('/:id/review', canManage(), validate(idParamsSchema, 'params'), asyncHandler(controller.review));
