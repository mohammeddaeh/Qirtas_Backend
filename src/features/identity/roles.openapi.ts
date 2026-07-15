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
  updateRolePermissionsBodySchema,
  updateRoleLevelBodySchema,
  roleResponseSchema,
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
  summary: 'List roles (paginated, without permissions per item)',
  request: { query: paginationQuerySchema },
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
