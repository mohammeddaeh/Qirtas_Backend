import { Router } from 'express';
import { asyncHandler } from '../../http/async-handler.js';
import { publicRoute } from '../../http/route-marker.js';
import { validate } from '../../validation/validate.js';
import { privateFileQuerySchema } from '../dtos/files.dto.js';
import * as filesController from '../controllers/files.controller.js';

/**
 * Serves stored files. Both routes are `publicRoute` by design and for
 * different reasons:
 *
 * - `public/*` — catalog images, meant for guests.
 * - `private/*` — gated by the link's signature, not by a session, because the
 *   reader is an image widget or a downloader that cannot carry a token. The
 *   permission check happened when the link was issued.
 */
export const filesRouter = Router();

filesRouter.get('/public/*', publicRoute, asyncHandler(filesController.getPublicFile));

filesRouter.get(
  '/private/*',
  publicRoute,
  validate(privateFileQuerySchema, 'query'),
  asyncHandler(filesController.getPrivateFile),
);
