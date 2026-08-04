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
  resubmitRegistrationBodySchema,
  decideRegistrationBodySchema,
  loginBodySchema,
  bootstrapSuperAdminBodySchema,
  updateUserBodySchema,
  createUserByAdminBodySchema,
  userResponseSchema,
  loginResponseSchema,
  currentUserResponseSchema,
  usersFilterQuerySchema,
} from './dtos/users.dto.js';

const tags = ['Users & Authentication'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/users',
  tags,
  summary: 'List users (paginated, filterable, sortable)',
  request: { query: paginationQuerySchema.merge(usersFilterQuerySchema) },
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
  path: '/api/v1/users/me',
  tags,
  summary: "Get the calling user's own data + current effective permission keys",
  description:
    'Requires only requireAuth (any authenticated user reads their own data) — no specific permission. Same {user, permission_keys} shape login() returns, minus token/session_id (not needed here). Backs the frontend\'s silent background-refresh after restoring a cached session — see docs/reference/session_permission_integrity.md §6/§10.',
  responses: {
    200: {
      description: 'The calling user + their current permission keys',
      ...jsonBody(successEnvelope(currentUserResponseSchema)),
    },
    ...unauthorizedResponse,
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
  path: '/api/v1/users',
  tags,
  summary: 'Admin-direct creation of a fully-active user account',
  description:
    'Distinct from POST /users/register (self-service + later admin review via decide-registration). Here an admin creates the account directly on someone else\'s behalf — the admin issuing this call IS the approval, by definition. Lands at status=active immediately with role_id (required) and optional branch_id/ownership_percentage assigned in this single call, mirroring what decide-registration\'s approve branch does in two steps. Requires users.manage.',
  request: { body: jsonBody(createUserByAdminBodySchema) },
  responses: {
    201: {
      description: 'User created and active',
      ...jsonBody(successEnvelope(userResponseSchema)),
    },
    ...unauthorizedResponse,
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
  method: 'patch',
  path: '/api/v1/users/{id}',
  tags,
  summary: "Update a user's identity/profile fields",
  description:
    'Edits first_name/last_name/email/phone only — status transitions (suspend/disable/reactivate/decide-registration) and password change each have their own dedicated endpoint and are never touched here.',
  request: { params: userIdParamsSchema, body: jsonBody(updateUserBodySchema) },
  responses: {
    200: { description: 'User updated', ...jsonBody(successEnvelope(userResponseSchema)) },
    ...commonErrorResponses,
    403: {
      description:
        'Target account is root-protected (is_root_protected=true) — rejected unconditionally, regardless of who is asking, including the root account acting on itself.',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(403) }),
      ),
    },
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
    'pending_approval and rejected still succeed (200) and return a real session — the account stays reachable (status screen, edit-and-resubmit) even after the app is reinstalled. That session unlocks nothing protected: it has zero effective permission_keys since these statuses never have an active role assignment. suspended/disabled are hard-rejected with a distinct 403 message. Wrong credentials always return a generic 401 (no email enumeration).',
  request: { body: jsonBody(loginBodySchema) },
  responses: {
    200: {
      description:
        'Login successful — check user.status: pending_approval/rejected get a session but permission_keys is always empty',
      ...jsonBody(successEnvelope(loginResponseSchema)),
    },
    401: {
      description: 'Invalid email or password',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(401) }),
      ),
    },
    403: {
      description: 'Account is suspended or disabled',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(403) }),
      ),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/me/resubmit-registration',
  tags,
  summary: 'Resubmit a new request after a rejection — calling user only',
  description:
    'Only valid when the calling user\'s own status is rejected. Flips status back to pending_approval with the newly requested role/branch/ownership%, clearing the previous rejection_reason/decided_at/decided_by. Identified entirely by session (requireAuth) — no :id in the path.',
  request: { body: jsonBody(resubmitRegistrationBodySchema) },
  responses: {
    200: { description: 'Resubmitted, pending admin approval again', ...jsonBody(successEnvelope(userResponseSchema)) },
    ...unauthorizedResponse,
    ...commonErrorResponses,
    409: {
      description: 'Only a rejected registration can be resubmitted',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(409) }),
      ),
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/logout',
  tags,
  summary: 'Log out — ends only the calling session (identified by its own Bearer token)',
  description:
    'Other concurrent sessions for the same user are left untouched (multi-session login is allowed by design). Idempotent — always returns 200 even if the token was already invalid/absent.',
  responses: {
    200: { description: 'Session ended (or was already invalid)', ...jsonBody(successEnvelope(z.null())) },
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
    403: {
      description:
        'Target account is root-protected (is_root_protected=true) — rejected unconditionally, regardless of who is asking, including the root account acting on itself.',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(403) }),
      ),
    },
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
    403: {
      description:
        'Target account is root-protected (is_root_protected=true) — rejected unconditionally, regardless of who is asking, including the root account acting on itself.',
      ...jsonBody(
        z.object({ status: z.literal(false), message: z.string(), code: z.literal(403) }),
      ),
    },
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
