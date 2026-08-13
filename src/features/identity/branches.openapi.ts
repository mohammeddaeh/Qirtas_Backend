import { z } from 'zod';
import {
  registry,
  successEnvelope,
  paginatedSchema,
  commonErrorResponses,
} from '../../core/openapi/registry.js';
import { paginationQuerySchema } from '../../core/pagination/pagination.js';
import {
  branchIdParamsSchema,
  createBranchBodySchema,
  updateBranchBodySchema,
  branchResponseSchema,
  branchesFilterQuerySchema,
} from './dtos/branches.dto.js';

const tags = ['Branches'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/branches',
  tags,
  summary: 'List branches (paginated, filterable, sortable)',
  description:
    'All query params below are optional — omitting them returns every branch, unfiltered, newest first (see docs/rest_api.md §6.1).',
  request: { query: paginationQuerySchema.merge(branchesFilterQuerySchema) },
  responses: {
    200: {
      description: 'Paginated list of branches',
      ...jsonBody(successEnvelope(paginatedSchema(branchResponseSchema))),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/branches/{id}',
  tags,
  summary: 'Get a single branch',
  request: { params: branchIdParamsSchema },
  responses: {
    200: { description: 'The branch', ...jsonBody(successEnvelope(branchResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/branches',
  tags,
  summary: 'Create a branch',
  request: { body: jsonBody(createBranchBodySchema) },
  responses: {
    201: { description: 'Branch created', ...jsonBody(successEnvelope(branchResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/branches/{id}',
  tags,
  summary: "Update a branch's data or status",
  request: { params: branchIdParamsSchema, body: jsonBody(updateBranchBodySchema) },
  responses: {
    200: { description: 'Branch updated', ...jsonBody(successEnvelope(branchResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/branches/{id}',
  tags,
  summary: 'Delete a branch that has never been used',
  description:
    'Hard delete, permitted only when NO assignment and NO ownership has ever referenced this branch, and it is not the default. Refuses 409 `branch_has_history` otherwise — archive it instead. Requires `branches.manage`.',
  request: { params: branchIdParamsSchema },
  responses: {
    200: { description: 'Branch deleted', ...jsonBody(successEnvelope(z.null())) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/branches/{id}/archive',
  tags,
  summary: 'Archive a branch (hide it without destroying its history)',
  description:
    'Requires `branches.manage` AND `records.archive`. Permitted when no assignment and no ownership is currently open on the branch; sets `status` to `closed` in the same write. Refuses 409 `branch_has_active_assignments` / `branch_has_active_ownerships`. Idempotent.',
  request: { params: branchIdParamsSchema },
  responses: {
    200: { description: 'Branch archived', ...jsonBody(successEnvelope(branchResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/branches/{id}/unarchive',
  tags,
  summary: 'Restore an archived branch',
  description:
    'Requires `branches.manage` AND `records.archive`. Clears `archived_at`; the branch returns as `closed`, since reopening it is a separate decision. Idempotent.',
  request: { params: branchIdParamsSchema },
  responses: {
    200: { description: 'Branch restored', ...jsonBody(successEnvelope(branchResponseSchema)) },
    ...commonErrorResponses,
  },
});
