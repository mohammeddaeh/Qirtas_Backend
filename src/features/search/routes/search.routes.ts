import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requireAnyPermission } from '../../../core/http/require-permission.js';
import { validate } from '../../../core/validation/validate.js';
import { searchQuerySchema } from '../dtos/search.dto.js';
import * as controller from '../controllers/search.controller.js';
import { SEARCH_KEYS } from '../services/search.service.js';

/**
 * «انتقل إلى…» records (docs/reference/global_search.md, rest_api.md §34).
 * Entry needs any one of the kinds' keys; each kind is then gated on its own
 * key — and invoices and print orders on the reader's branches — in the service.
 */
export const searchRouter: Router = Router();

searchRouter.get(
  '/',
  requireAnyPermission(Object.values(SEARCH_KEYS)),
  validate(searchQuerySchema, 'query'),
  asyncHandler(controller.search),
);
