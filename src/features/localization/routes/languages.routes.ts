import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requireApprovedStaff } from '../../../core/http/require-actor.js';
import { publicRoute } from '../../../core/http/route-marker.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import {
  languageCodeParamsSchema,
  createLanguageBodySchema,
  updateLanguageBodySchema,
} from '../dtos/languages.dto.js';
import { replaceTranslationsBodySchema } from '../dtos/translations.dto.js';
import * as languagesController from '../controllers/languages.controller.js';

export const languagesRouter = Router();

// The app's own UI text — read by every visitor, guest and customer included, on
// every launch. Both return ACTIVE languages only, so nothing unpublished leaks.
// They were `requireAuth` (staff only): a guest's call failed silently, and a
// customer's came back 401, which the client read as an expired session and
// answered by signing the customer out on every start.
languagesRouter.get('/', publicRoute, asyncHandler(languagesController.listLanguages));

languagesRouter.get(
  '/:code/translations',
  publicRoute,
  validate(languageCodeParamsSchema, 'params'),
  asyncHandler(languagesController.getTranslations),
);

languagesRouter.get(
  '/:code',
  requireApprovedStaff,
  validate(languageCodeParamsSchema, 'params'),
  asyncHandler(languagesController.getLanguageByCode),
);

languagesRouter.post(
  '/',
  requirePermission('localization.manage'),
  validate(createLanguageBodySchema, 'body'),
  asyncHandler(languagesController.createLanguage),
);

languagesRouter.patch(
  '/:code',
  requirePermission('localization.manage'),
  validate(languageCodeParamsSchema, 'params'),
  validate(updateLanguageBodySchema, 'body'),
  asyncHandler(languagesController.updateLanguage),
);

languagesRouter.put(
  '/:code/translations',
  requirePermission('localization.manage'),
  validate(languageCodeParamsSchema, 'params'),
  validate(replaceTranslationsBodySchema, 'body'),
  asyncHandler(languagesController.replaceTranslations),
);

languagesRouter.post(
  '/:code/deactivate',
  requirePermission('localization.manage'),
  validate(languageCodeParamsSchema, 'params'),
  asyncHandler(languagesController.deactivateLanguage),
);
