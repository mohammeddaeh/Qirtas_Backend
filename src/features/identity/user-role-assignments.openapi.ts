import { z } from 'zod';
import {
  registry,
  successEnvelope,
  commonErrorResponses,
  unauthorizedResponse,
} from '../../core/openapi/registry.js';
import {
  userIdParamsSchema,
  assignmentIdParamsSchema,
  createAssignmentBodySchema,
  transferAssignmentBodySchema,
  userRoleAssignmentResponseSchema,
} from './dtos/user-role-assignments.dto.js';

const tags = ['Role Assignments'];
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
  path: '/api/v1/users/{userId}/role-assignments',
  tags,
  summary: "List a user's currently active role assignments",
  request: { params: userIdParamsSchema },
  responses: {
    200: {
      description: 'Active assignments',
      ...jsonBody(successEnvelope(z.array(userRoleAssignmentResponseSchema))),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/{userId}/role-assignments',
  tags,
  summary: 'Assign a new role to a user',
  description:
    "Rejected (403) if the target role's level is at or above the acting actor's own highest authority level (privilege-escalation guard).",
  request: { params: userIdParamsSchema, body: jsonBody(createAssignmentBodySchema) },
  responses: {
    201: {
      description: 'Assignment created',
      ...jsonBody(successEnvelope(userRoleAssignmentResponseSchema)),
    },
    ...unauthorizedResponse,
    403: {
      description: 'Cannot assign a role at or above your own authority level',
      ...businessError(403),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/role-assignments/{assignmentId}/transfer',
  tags,
  summary: 'Transfer a user to a new role/branch',
  description:
    'Closes the current assignment and opens a new one atomically — never mutates branch_id in place, preserving history. Blocked (409) if this is the last active staff member holding this role in this branch, with no qualified replacement.',
  request: { params: assignmentIdParamsSchema, body: jsonBody(transferAssignmentBodySchema) },
  responses: {
    200: {
      description: 'Transferred',
      ...jsonBody(successEnvelope(userRoleAssignmentResponseSchema)),
    },
    ...unauthorizedResponse,
    409: {
      description: 'Last qualified staff for this role/branch — assign a replacement first',
      ...businessError(409),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/role-assignments/{assignmentId}/end',
  tags,
  summary: 'End a role assignment (offboarding)',
  description: 'Same last-qualified-staff guard as transfer.',
  request: { params: assignmentIdParamsSchema },
  responses: {
    200: {
      description: 'Assignment ended',
      ...jsonBody(successEnvelope(userRoleAssignmentResponseSchema)),
    },
    409: {
      description: 'Last qualified staff for this role/branch — assign a replacement first',
      ...businessError(409),
    },
    ...commonErrorResponses,
  },
});
