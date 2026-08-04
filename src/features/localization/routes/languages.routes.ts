import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requireAuth } from '../../../core/http/require-actor.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import {
  languageCodeParamsSchema,
  createLanguageBodySchema,
  updateLanguageBodySchema,
} from '../dtos/languages.dto.js';
import { replaceTranslationsBodySchema } from '../dtos/translations.dto.js';
import * as languagesController from '../controllers/languages.controller.js';

export const languagesRouter = Router();

languagesRouter.get('/', requireAuth, asyncHandler(languagesController.listLanguages));

languagesRouter.get(
  '/:code/translations',
  requireAuth,
  validate(languageCodeParamsSchema, 'params'),
  asyncHandler(languagesController.getTranslations),
);

languagesRouter.get(
  '/:code',
  requireAuth,
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
