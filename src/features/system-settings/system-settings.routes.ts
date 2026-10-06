import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/async-handler.js';
import { buildActorContext, requireActorId } from '../../core/http/require-actor.js';
import { requirePermission } from '../../core/http/require-permission.js';
import { ok } from '../../core/http/response.js';
import { DATE_FORMATS, DOC_TYPES, type DocType } from '../../core/numbering/numbering.js';
import { validate } from '../../core/validation/validate.js';
import * as service from './system-settings.service.js';

/**
 * `/api/v1/system-settings/*` — central rules (`docs/reference/system_settings.md`).
 * One key for the whole area: they are the shop's operating rules, set by the
 * same person.
 */
export const systemSettingsRouter: Router = Router();

const canManage = () =>
  requirePermission('settings.manage', {
    display: { ar: 'إعدادات النظام', en: 'System Settings' },
    sensitive: true,
  });

const formatBody = z
  .object({
    prefix: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.string().max(4)),
    date_format: z.enum(DATE_FORMATS),
    digits: z.number().int().min(1).max(12),
  })
  .strict();

const docTypeParams = z.object({ doc_type: z.enum(DOC_TYPES) }).strict();

const previewBody = formatBody.extend({ doc_type: z.enum(DOC_TYPES), branch_code: z.string().trim().max(6).optional() });

systemSettingsRouter.get(
  '/numbering',
  canManage(),
  asyncHandler(async (_req: Request, res: Response) => ok(res, await service.getNumbering())),
);

/** What a draft would print — before saving, with the reason it would be refused. */
systemSettingsRouter.post(
  '/numbering/preview',
  canManage(),
  validate(previewBody, 'body'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof previewBody>;
    const { doc_type, branch_code, ...draft } = body;
    const sample = branch_code || (await service.getNumbering()).sample_branch_code;
    ok(res, await service.previewNumbering(doc_type, draft, sample));
  }),
);

systemSettingsRouter.put(
  '/numbering/:doc_type',
  canManage(),
  validate(docTypeParams, 'params'),
  validate(formatBody, 'body'),
  asyncHandler(async (req: Request, res: Response) =>
    ok(
      res,
      await service.setNumbering(
        buildActorContext(req, requireActorId(req)),
        req.params['doc_type'] as DocType,
        req.body as z.infer<typeof formatBody>,
      ),
    ),
  ),
);
