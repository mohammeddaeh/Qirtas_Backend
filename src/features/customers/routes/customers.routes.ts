import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import { requireCustomer, requireVerifiedCustomer } from '../../../core/http/require-customer.js';
import { publicRoute } from '../../../core/http/route-marker.js';
import { customerRegisterRateLimit } from '../../../core/middleware/register-rate-limit.js';
import {
  customerIdParamsSchema,
  customersFilterQuerySchema,
  deleteMeBodySchema,
  decideWholesaleBodySchema,
  registerCustomerBodySchema,
  updateCustomerProfileBodySchema,
} from '../dtos/customers.dto.js';
import * as customersController from '../controllers/customers.controller.js';

/**
 * `/api/v1/customers/*` — the shopper's own account.
 *
 * Sign-in is NOT here: `POST /users/login` serves every population and resolves
 * the realm from the address, so a person never has to say which kind they are.
 * Session endpoints (verify-email, sessions, change-password, logout) are the
 * shared `/auth/*` ones — they act on whichever realm the token belongs to.
 */
export const customersRouter = Router();

customersRouter.post(
  '/register',
  publicRoute,
  validate(registerCustomerBodySchema, 'body'),
  customerRegisterRateLimit,
  asyncHandler(customersController.register),
);

/** Signed in is enough — an unverified customer may view and edit their own profile. */
customersRouter.get('/me', requireCustomer, asyncHandler(customersController.getMe));

customersRouter.patch(
  '/me',
  requireCustomer,
  validate(updateCustomerProfileBodySchema, 'body'),
  asyncHandler(customersController.updateMe),
);

// Self-service erase. Before `/:id` (Express matches in mount order) and after
// the auth guard: a customer token only.
customersRouter.delete(
  '/me',
  requireCustomer,
  validate(deleteMeBodySchema, 'body'),
  asyncHandler(customersController.deleteMe),
);

/**
 * The first route in the system to carry `requireVerifiedCustomer`: a wholesale
 * account is a commercial relationship and must not start from an address nobody
 * has proven. An unverified customer gets `403 email_verification_required`,
 * which the app answers by opening the code screen.
 */
customersRouter.post(
  '/me/wholesale-request',
  requireVerifiedCustomer,
  asyncHandler(customersController.requestWholesale),
);

// ── Admin side ────────────────────────────────────────────────────────────────
// Every route below is staff-only (`requirePermission`) — a customer token never
// resolves as `req.user`, so it is a 401 here without a line saying so. They
// sit AFTER `/me`: Express matches in mount order, and `/:id` would otherwise
// swallow `/me` as a non-numeric id.

const listCustomersQuerySchema = paginationQuerySchema.merge(customersFilterQuerySchema);

customersRouter.get(
  '/',
  requirePermission('customers.view'),
  validate(listCustomersQuerySchema, 'query'),
  asyncHandler(customersController.listCustomers),
);

customersRouter.get(
  '/:id',
  requirePermission('customers.view'),
  validate(customerIdParamsSchema, 'params'),
  asyncHandler(customersController.getCustomerById),
);

customersRouter.post(
  '/:id/suspend',
  requirePermission('customers.manage'),
  validate(customerIdParamsSchema, 'params'),
  asyncHandler(customersController.suspendCustomer),
);

customersRouter.post(
  '/:id/disable',
  requirePermission('customers.manage'),
  validate(customerIdParamsSchema, 'params'),
  asyncHandler(customersController.disableCustomer),
);

customersRouter.post(
  '/:id/reactivate',
  requirePermission('customers.manage'),
  validate(customerIdParamsSchema, 'params'),
  asyncHandler(customersController.reactivateCustomer),
);

customersRouter.post(
  '/:id/wholesale/decide',
  requirePermission('customers.wholesale'),
  validate(customerIdParamsSchema, 'params'),
  validate(decideWholesaleBodySchema, 'body'),
  asyncHandler(customersController.decideWholesale),
);

// Retiring a record is `records.archive` everywhere in this system (branches,
// roles, users) — the same key, so one grant means the same thing on every screen.
customersRouter.post(
  '/:id/archive',
  requirePermission('records.archive'),
  validate(customerIdParamsSchema, 'params'),
  asyncHandler(customersController.archiveCustomer),
);

customersRouter.post(
  '/:id/unarchive',
  requirePermission('records.archive'),
  validate(customerIdParamsSchema, 'params'),
  asyncHandler(customersController.unarchiveCustomer),
);

customersRouter.delete(
  '/:id',
  requirePermission('customers.manage'),
  validate(customerIdParamsSchema, 'params'),
  asyncHandler(customersController.deleteCustomer),
);

// Support actions: the employee triggers, the customer's own inbox receives.
customersRouter.post(
  '/:id/resend-verification',
  requirePermission('customers.manage'),
  validate(customerIdParamsSchema, 'params'),
  asyncHandler(customersController.resendVerification),
);

customersRouter.post(
  '/:id/password-reset',
  requirePermission('customers.manage'),
  validate(customerIdParamsSchema, 'params'),
  asyncHandler(customersController.sendPasswordReset),
);

customersRouter.get(
  '/:id/activity',
  requirePermission('customers.view'),
  validate(customerIdParamsSchema, 'params'),
  validate(paginationQuerySchema, 'query'),
  asyncHandler(customersController.listActivity),
);
