import express, { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler.js';
import { requireApprovedStaff } from '../../http/require-actor.js';
import { validate } from '../../validation/validate.js';
import { uploadTransferFile } from '../middleware/upload.js';
import * as controller from '../controllers/data-transfer.controller.js';

/**
 * `/api/v1/data-transfer/*` — generic, and mounted once for every resource that
 * will ever exist in this application.
 *
 * `requireApprovedStaff` before `validate` on every route, matching the rule in
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

dataTransferRouter.get('/resources', requireApprovedStaff, asyncHandler(controller.listResources));

dataTransferRouter.get(
  '/:resource/export',
  requireApprovedStaff,
  validate(resourceParamsSchema, 'params'),
  asyncHandler(controller.exportResource),
);

dataTransferRouter.get(
  '/:resource/template',
  requireApprovedStaff,
  validate(resourceParamsSchema, 'params'),
  asyncHandler(controller.downloadTemplate),
);

/**
 * `express.json()`'s default body limit is **100 KB**, and the app-wide parser
 * in `app.ts` uses it.
 *
 * The edit loop sends the whole grid back — up to `MAX_PREVIEW_ROWS` rows of
 * text — which passes 100 KB at a few hundred rows. Left alone, re-validating a
 * medium file fails with express's own 413 before any of this module's code
 * runs, and the message says nothing about rows.
 *
 * 5 MB, matching the upload limit in `middleware/upload.ts`: the two paths carry
 * the same data and there is no reason for one to accept what the other refuses.
 * Scoped to this route, so the rest of the API keeps the tighter default.
 */
const importJsonBody = express.json({ limit: '5mb' });

dataTransferRouter.post(
  '/:resource/import',
  // Order matters: authentication, then the path check, then the body.
  // Parsing a 5 MB body before deciding the caller is anonymous does the work
  // an attacker wanted done — `requireApprovedStaff` first means an unauthenticated
  // flood is refused at the header.
  requireApprovedStaff,
  validate(resourceParamsSchema, 'params'),
  // Both parsers run, and each ignores the other's content type: JSON for the
  // edit loop, multipart for the first upload.
  importJsonBody,
  uploadTransferFile,
  asyncHandler(controller.importResource),
);
