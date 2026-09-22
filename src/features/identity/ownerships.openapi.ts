import { z } from 'zod';
import { registry, successEnvelope, commonErrorResponses } from '../../core/openapi/registry.js';
import {
  createOwnershipBodySchema,
  listOwnershipsQuerySchema,
  ownershipResponseSchema,
  ownershipIdParamsSchema,
  revisePercentageBodySchema,
} from './dtos/ownerships.dto.js';

const tags = ['Ownerships'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/ownerships',
  tags,
  summary: 'List active ownership records with names, optionally one branch only',
  request: { query: listOwnershipsQuerySchema },
  responses: {
    200: {
      description: 'Active ownership records',
      ...jsonBody(successEnvelope(z.array(ownershipResponseSchema))),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/ownerships',
  tags,
  summary: 'Register an ownership percentage',
  description:
    'Strict cap: any save that would push the active-percentage sum for the scope past 100% is rejected outright (422) — no soft warning (users_roles.md, 2026-07-09).',
  request: { body: jsonBody(createOwnershipBodySchema) },
  responses: {
    201: {
      description: 'Ownership recorded',
      ...jsonBody(successEnvelope(ownershipResponseSchema)),
    },
    ...commonErrorResponses,
    422: {
      description: 'Would exceed the 100% cap for this scope, or validation failed',
      content: {
        'application/json': {
          schema: z.object({
            status: z.literal(false),
            message: z.string(),
            code: z.literal(422),
            errors: z.record(z.array(z.string())).optional(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/ownerships/{id}/revise',
  tags,
  summary: 'Resize a share (closes the record, opens a new one)',
  request: { params: ownershipIdParamsSchema, body: jsonBody(revisePercentageBodySchema) },
  responses: {
    200: { description: 'The new record', ...jsonBody(successEnvelope(ownershipResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/ownerships/{id}/end',
  tags,
  summary: 'Close a share (sold / withdrawn); the record stays as history',
  request: { params: ownershipIdParamsSchema },
  responses: {
    200: { description: 'Closed', ...jsonBody(successEnvelope(z.null())) },
    ...commonErrorResponses,
  },
});
