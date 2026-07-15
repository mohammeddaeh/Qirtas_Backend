import { z } from 'zod';
import {
  registry,
  successEnvelope,
  paginatedSchema,
  commonErrorResponses,
  unauthorizedResponse,
} from '../../core/openapi/registry.js';
import { paginationQuerySchema } from '../../core/pagination/pagination.js';
import {
  userIdParamsSchema,
  registerStaffBodySchema,
  decideRegistrationBodySchema,
  loginBodySchema,
  bootstrapSuperAdminBodySchema,
  userResponseSchema,
  loginResponseSchema,
} from './dtos/users.dto.js';

const tags = ['Users & Authentication'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/users',
  tags,
  summary: 'List users (paginated)',
  request: { query: paginationQuerySchema },
  responses: {
    200: {
      description: 'Paginated list of users',
      ...jsonBody(successEnvelope(paginatedSchema(userResponseSchema))),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/users/{id}',
  tags,
  summary: 'Get a single user',
  request: { params: userIdParamsSchema },
  responses: {
    200: { description: 'The user', ...jsonBody(successEnvelope(userResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/register',
  tags,
  summary: 'Self-registration — the single entry point for every internal (staff/partner) account',
  description:
    'Creates a User with status=pending_approval and zero active role assignment. An admin must decide (approve/edit/reject) via /users/{id}/decide-registration before the account can do anything. See docs/reference/users_roles.md — Internal Self-Registration & Approval.',
  request: { body: jsonBody(registerStaffBodySchema) },
  responses: {
    201: {
      description: 'Registration submitted, pending admin approval',
      ...jsonBody(successEnvelope(userResponseSchema)),
    },
    ...commonErrorResponses,
    409: {
      description: 'An account with this email already exists',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(409) }),
      ),
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/bootstrap-super-admin',
  tags,
  summary: 'First-run setup wizard — create the first Super Admin',
  description:
    'Only succeeds while zero User rows exist in the entire system. Not reachable after the first account is created.',
  request: { body: jsonBody(bootstrapSuperAdminBodySchema) },
  responses: {
    201: {
      description: 'Super Admin account created',
      ...jsonBody(successEnvelope(userResponseSchema)),
    },
    403: {
      description: 'Setup has already been completed',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(403) }),
      ),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/login',
  tags,
  summary: 'Log in with email + password',
  description:
    'Rejects with a distinct 403 message per non-active status (pending_approval / rejected+reason / suspended / disabled). Wrong credentials always return a generic 401 (no email enumeration).',
  request: { body: jsonBody(loginBodySchema) },
  responses: {
    200: { description: 'Login successful', ...jsonBody(successEnvelope(loginResponseSchema)) },
    401: {
      description: 'Invalid email or password',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(401) }),
      ),
    },
    403: {
      description: 'Account not in an active state (pending/rejected/suspended/disabled)',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(403) }),
      ),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/{id}/decide-registration',
  tags,
  summary: 'Admin decision on a pending_approval account: approve (as-is or edited) or reject',
  request: { params: userIdParamsSchema, body: jsonBody(decideRegistrationBodySchema) },
  responses: {
    200: { description: 'Decision applied', ...jsonBody(successEnvelope(userResponseSchema)) },
    ...unauthorizedResponse,
    ...commonErrorResponses,
    409: {
      description: 'This account is not pending approval',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(409) }),
      ),
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/{id}/suspend',
  tags,
  summary: 'Temporary, reversible hold (investigation, long leave) — distinct from disable',
  request: { params: userIdParamsSchema },
  responses: {
    200: { description: 'User suspended', ...jsonBody(successEnvelope(userResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/{id}/disable',
  tags,
  summary:
    'Permanent offboarding — never a hard delete, historical records stay attributed forever',
  request: { params: userIdParamsSchema },
  responses: {
    200: { description: 'User disabled', ...jsonBody(successEnvelope(userResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/{id}/reactivate',
  tags,
  summary:
    'Reactivate a suspended or disabled account back to active — no new account is ever created',
  request: { params: userIdParamsSchema },
  responses: {
    200: { description: 'User reactivated', ...jsonBody(successEnvelope(userResponseSchema)) },
    ...commonErrorResponses,
    409: {
      description: 'Cannot reactivate a user with this status',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(409) }),
      ),
    },
  },
});
