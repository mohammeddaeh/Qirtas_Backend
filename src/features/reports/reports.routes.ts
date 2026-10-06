import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/async-handler.js';
import { requirePermission } from '../../core/http/require-permission.js';
import { ok } from '../../core/http/response.js';
import { paginated, paginationQuerySchema, toPaginationParams } from '../../core/pagination/pagination.js';
import { validate } from '../../core/validation/validate.js';
import * as service from './reports.service.js';

/**
 * `/api/v1/reports/*` — the financial reports (`finance_ledger.md` §٥). One key:
 * reading the books is one decision, separate from selling or refunding.
 */
export const reportsRouter: Router = Router();

const canView = () =>
  requirePermission('reports.financial.view');

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const reportQuery = z
  .object({
    branch_id: z.coerce.number().int().positive().optional(),
    from: day,
    to: day,
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['from'] });

const lossesQuery = paginationQuerySchema
  .extend({
    branch_id: z.coerce.number().int().positive().optional(),
    from: day,
    to: day,
    type: z
      .enum(['loss_damaged_return', 'loss_print_return', 'loss_ready_writeoff', 'loss_inventory', 'print_waste'])
      .optional(),
  })
  .strict();

reportsRouter.get(
  '/summary',
  canView(),
  validate(reportQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof reportQuery>;
    ok(res, await service.summary({ branchId: q.branch_id, from: q.from, to: q.to }));
  }),
);

/** The entries behind the losses — each names the document it came from. */
reportsRouter.get(
  '/losses',
  canView(),
  validate(lossesQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof lossesQuery>;
    const params = toPaginationParams(q);
    const { items, total } = await service.lossEntries(
      { branchId: q.branch_id, from: q.from, to: q.to, type: q.type },
      params.limit,
      (params.page - 1) * params.limit,
    );
    ok(res, paginated(items, total, params));
  }),
);
