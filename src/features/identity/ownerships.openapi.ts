import { z } from 'zod';
import { registry, successEnvelope, commonErrorResponses } from '../../core/openapi/registry.js';
import {
  createOwnershipBodySchema,
  listOwnershipsQuerySchema,
  ownershipResponseSchema,
} from './dtos/ownerships.dto.js';

const tags = ['Ownerships'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/ownerships',
  tags,
  summary: 'List active ownership records, optionally filtered by branch scope',
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
