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
  endAssignmentBodySchema,
  userRoleAssignmentResponseSchema,
} from './dtos/user-role-assignments.dto.js';

const tags = ['Role Assignments'];

/**
 * Both release paths answer 409 the same two ways, and the pair is only useful
 * read together — the whole point of the two keys is that one is overridable
 * and the other is not.
 */
const LAST_HOLDER_409 =
  'Answers 409 `last_qualified_staff` when this is the last active holder of a ' +
  '`management`/`system` role in an operating branch — a WARNING: re-send with ' +
  '`force: true` to proceed. `data` carries `overridable: true` plus the ' +
  '(role_id, role_name, branch_id, branch_name) of the gap, so the client can ' +
  'offer to fill that exact post instead of an empty picker. Answers 409 ' +
  '`last_system_role_holder` (`data.overridable: false`) when releasing them ' +
  'would leave nobody holding `users.manage` — `force` does NOT clear that one, ' +
  'because no one inside the app could grant it back.';
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
    'Closes the current assignment and opens a new one atomically — never mutates branch_id in place, preserving history. ' +
    LAST_HOLDER_409,
  request: { params: assignmentIdParamsSchema, body: jsonBody(transferAssignmentBodySchema) },
  responses: {
    200: {
      description: 'Transferred',
      ...jsonBody(successEnvelope(userRoleAssignmentResponseSchema)),
    },
    ...unauthorizedResponse,
    409: { description: LAST_HOLDER_409, ...businessError(409) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/role-assignments/{assignmentId}/end',
  tags,
  summary: 'End a role assignment (offboarding)',
  description: 'Same last-holder warning as transfer. ' + LAST_HOLDER_409,
  request: { params: assignmentIdParamsSchema, body: jsonBody(endAssignmentBodySchema) },
  responses: {
    200: {
      description: 'Assignment ended',
      ...jsonBody(successEnvelope(userRoleAssignmentResponseSchema)),
    },
    409: { description: LAST_HOLDER_409, ...businessError(409) },
    ...commonErrorResponses,
  },
});
