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
} from './dtos/branches.dto.js';

const tags = ['Branches'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/branches',
  tags,
  summary: 'List branches (paginated)',
  request: { query: paginationQuerySchema },
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
