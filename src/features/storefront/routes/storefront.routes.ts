import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requireCustomer } from '../../../core/http/require-customer.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { publicRoute } from '../../../core/http/route-marker.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import {
  demandBodySchema,
  demandSummaryQuerySchema,
  storefrontBranchQuerySchema,
  storefrontProductsQuerySchema,
} from '../dtos/storefront.dto.js';
import * as storefrontController from '../controllers/storefront.controller.js';

/**
 * `/api/v1/storefront/*` — what a customer browses, and **public on purpose**.
 *
 * A guest sees the whole shop (§٨): prices, availability, everything but the
 * buying. Hiding the catalogue behind a login would ask people to sign up for
 * something they cannot see yet, and the gate that matters — `AccessGate` on
 * the client, `requireVerifiedCustomer` at checkout — sits where money moves.
 *
 * A customer token, when one is sent, changes exactly one thing: an approved
 * wholesale buyer also sees their own price (`customers.wholesale`).
 */
export const storefrontRouter: Router = Router();

storefrontRouter.get(
  '/categories',
  publicRoute,
  asyncHandler(storefrontController.listCategories),
);

storefrontRouter.get(
  '/collections',
  publicRoute,
  asyncHandler(storefrontController.listCollections),
);

storefrontRouter.get(
  '/products',
  publicRoute,
  validate(storefrontProductsQuerySchema, 'query'),
  asyncHandler(storefrontController.listProducts),
);

storefrontRouter.get(
  '/products/:id',
  publicRoute,
  validate(idParamsSchema, 'params'),
  validate(storefrontBranchQuerySchema, 'query'),
  asyncHandler(storefrontController.getProduct),
);

// ── «أعلمني عند التوفّر» و«اطلب توفيره بفرعي» (§٨) ──────────────────────────
//
// **للمسجَّل وحده** (`requireCustomer`): الإشعار يصل بقناة الحساب القائمة،
// ورقمٌ يكتبه ضيف يفتح قناة ثانية غير مبنيّة. وليست `requireVerifiedCustomer`
// لأن هذا ليس شراءً — طلبُ خبرٍ لا يستدعي إثبات بريد.
storefrontRouter.post(
  '/interest',
  requireCustomer,
  validate(demandBodySchema, 'body'),
  asyncHandler(storefrontController.recordDemand),
);

storefrontRouter.get(
  '/interest',
  requireCustomer,
  validate(demandSummaryQuerySchema, 'query'),
  asyncHandler(storefrontController.listMyDemand),
);

storefrontRouter.delete(
  '/interest/:id',
  requireCustomer,
  validate(idParamsSchema, 'params'),
  asyncHandler(storefrontController.cancelDemand),
);

// وجه المدير للإشارة نفسها: يقرأ مخزون فرعه، فحارسه `inventory.view`.
// ويعيش هنا لا بموديول المخزون لأن الجدول جدول المتجر — والموديول الذي يملك
// الصفّ هو الذي يقرؤه.
storefrontRouter.get(
  '/demand',
  requirePermission('inventory.view', {
    display: { ar: 'عرض المخزون', en: 'View Stock' },
  }),
  validate(demandSummaryQuerySchema, 'query'),
  asyncHandler(storefrontController.listDemandSummary),
);
