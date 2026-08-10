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
  roleIdParamsSchema,
  createRoleBodySchema,
  updateRoleBodySchema,
  updateRolePermissionsBodySchema,
  updateRoleLevelBodySchema,
  roleResponseSchema,
  rolesFilterQuerySchema,
} from './dtos/roles.dto.js';

const tags = ['Roles (RBAC)'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const businessError = (code: number) => ({
  content: {
    'application/json': {
      schema: z.object({ status: z.literal(false), message: z.string(), code: z.literal(code) }),
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/roles',
  tags,
  summary: 'List roles (paginated, filterable, sortable, without permissions per item)',
  request: { query: paginationQuerySchema.merge(rolesFilterQuerySchema) },
  responses: {
    200: {
      description: 'Paginated list of roles',
      ...jsonBody(successEnvelope(paginatedSchema(roleResponseSchema))),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/roles/{id}',
  tags,
  summary: 'Get a single role with its full permission list',
  request: { params: roleIdParamsSchema },
  responses: {
    200: {
      description: 'The role, with permissions',
      ...jsonBody(successEnvelope(roleResponseSchema)),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/roles',
  tags,
  summary: 'Create a role',
  description:
    'Role name must be unique. If the resulting permission set exactly matches an existing active role, the request is rejected with 409 unless force=true is passed (role-explosion prevention, users_roles.md 2026-07-09).',
  request: { body: jsonBody(createRoleBodySchema) },
  responses: {
    201: {
      description: 'Role created (message notes if the active-role soft cap of 25 was exceeded)',
      ...jsonBody(successEnvelope(roleResponseSchema)),
    },
    ...unauthorizedResponse,
    ...commonErrorResponses,
    409: {
      description: 'Name already in use, or exact permission-set duplicate without force=true',
      ...businessError(409),
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/roles/{id}/permissions',
  tags,
  summary: "Replace a role's full permission set",
  description:
    'Applies immediately and retroactively to every user currently assigned this role (no re-approval required), and notifies affected users. Logged to the audit log if any touched permission is isSensitive.',
  request: { params: roleIdParamsSchema, body: jsonBody(updateRolePermissionsBodySchema) },
  responses: {
    200: { description: 'Permissions updated', ...jsonBody(successEnvelope(roleResponseSchema)) },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/roles/{id}/level',
  tags,
  summary: "Change a role's authority level — Super Admin only",
  description:
    'level is immutable through any other path. This bypasses the usual relative-level check entirely (closes a privilege-escalation loophole) — the actor must actively hold the Super Admin role.',
  request: { params: roleIdParamsSchema, body: jsonBody(updateRoleLevelBodySchema) },
  responses: {
    200: { description: 'Level updated', ...jsonBody(successEnvelope(roleResponseSchema)) },
    ...unauthorizedResponse,
    403: { description: 'Actor does not hold the Super Admin role', ...businessError(403) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/roles/{id}',
  tags,
  summary: "Rename a role and/or change its category",
  description:
    'At least one of name/category is required. The Super Admin role cannot be renamed — authority checks identify it by name. Changing category to or from management/system changes whether the "last qualified staff" guard applies to this role\'s assignments, so both old and new values are audited. level is NOT editable here (see PUT /{id}/level).',
  request: { params: roleIdParamsSchema, body: jsonBody(updateRoleBodySchema) },
  responses: {
    200: { description: 'Role updated', ...jsonBody(successEnvelope(roleResponseSchema)) },
    403: {
      description: 'The Super Admin role cannot be renamed, or the role outranks the actor',
      ...businessError(403),
    },
    409: { description: 'Role name already in use', ...businessError(409) },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/roles/{id}/reactivate',
  tags,
  summary: 'Put a deactivated role back into service',
  description:
    'The counterpart to deactivate. Subject to the same relative-authority check as creating a role — reviving a high-authority role grants the same privilege.',
  request: { params: roleIdParamsSchema },
  responses: {
    200: { description: 'Role reactivated', ...jsonBody(successEnvelope(roleResponseSchema)) },
    403: { description: 'Role is at or above the actor authority level', ...businessError(403) },
    409: { description: 'Role is already active', ...businessError(409) },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/roles/{id}/deactivate',
  tags,
  summary: 'Deactivate a role (never a hard delete)',
  description:
    'Rejected if the role still has any active user assignment, or if it is the Super Admin role (permanently protected).',
  request: { params: roleIdParamsSchema },
  responses: {
    200: { description: 'Role deactivated', ...jsonBody(successEnvelope(roleResponseSchema)) },
    403: { description: 'The Super Admin role can never be deactivated', ...businessError(403) },
    409: {
      description: 'Role still has active assignments — reassign every user first',
      ...businessError(409),
    },
    ...commonErrorResponses,
  },
});
