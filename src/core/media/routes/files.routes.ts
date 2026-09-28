import { Router } from 'express';
import { asyncHandler } from '../../http/async-handler.js';
import { publicRoute } from '../../http/route-marker.js';
import { validate } from '../../validation/validate.js';
import { privateFileQuerySchema } from '../dtos/files.dto.js';
import * as filesController from '../controllers/files.controller.js';

/**
 * Serves stored files. Every route is `publicRoute` by design and for
 * different reasons:
 *
 * - `public/*` — catalog images, meant for guests.
 * - `private/*` — gated by the link's signature, not by a session, because the
 *   reader is an image widget or a downloader that cannot carry a token. The
 *   permission check happened when the link was issued.
 * - `uploads/:token` — the local driver's stand-in for a presigned S3 PUT. The
 *   token is the permission (issued after the owning feature checked the
 *   caller), and it names one key and one exact size. With `STORAGE_DRIVER=s3`
 *   the client uploads to the bucket and this route answers 404.
 */
export const filesRouter = Router();

filesRouter.get('/public/*', publicRoute, asyncHandler(filesController.getPublicFile));

filesRouter.get(
  '/private/*',
  publicRoute,
  validate(privateFileQuerySchema, 'query'),
  asyncHandler(filesController.getPrivateFile),
);

filesRouter.put('/uploads/:token', publicRoute, asyncHandler(filesController.putUpload));
