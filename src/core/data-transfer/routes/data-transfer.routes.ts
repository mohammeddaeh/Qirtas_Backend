import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth } from '../../http/require-actor.js';
import { validate } from '../../validation/validate.js';
import { uploadTransferFile } from '../middleware/upload.js';
import * as controller from '../controllers/data-transfer.controller.js';

/**
 * `/api/v1/data-transfer/*` — generic, and mounted once for every resource that
 * will ever exist in this application.
 *
 * `requireAuth` before `validate` on every route, matching the rule in
 * `core/http/require-actor.ts`: an anonymous caller is refused before their
 * input is parsed. None of these routes is ever public — an export is a bulk
 * read of somebody's data, which is the last thing to leave unauthenticated.
 *
 * The export query is **not** validated by middleware. `validate()` replaces
 * `req.query` with only what its schema declares, and each resource contributes
 * its own filters (`?q=` for notes) that this generic schema cannot know about
 * — they would be stripped before the resource ever saw them. Parsing happens
 * in `export.service.ts` instead, against the resource's own `filtersSchema`.
 */
export const dataTransferRouter = Router();

const resourceParamsSchema = z.object({
  // Bounded and charset-restricted: the value reaches a filename and a log
  // line, and an unbounded path segment in either is a needless liability.
  resource: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'Invalid resource name'),
});

dataTransferRouter.get('/resources', requireAuth, asyncHandler(controller.listResources));

dataTransferRouter.get(
  '/:resource/export',
  requireAuth,
  validate(resourceParamsSchema, 'params'),
  asyncHandler(controller.exportResource),
);

dataTransferRouter.get(
  '/:resource/template',
  requireAuth,
  validate(resourceParamsSchema, 'params'),
  asyncHandler(controller.downloadTemplate),
);

dataTransferRouter.post(
  '/:resource/import',
  // Order matters: authentication, then the path check, then the upload.
  // Parsing a 5 MB multipart body before deciding the caller is anonymous does
  // the work an attacker wanted done — `requireAuth` first means an
  // unauthenticated flood is refused at the header.
  requireAuth,
  validate(resourceParamsSchema, 'params'),
  uploadTransferFile,
  asyncHandler(controller.importResource),
);
