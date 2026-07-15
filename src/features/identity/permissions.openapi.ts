import { z } from 'zod';
import { registry, successEnvelope, commonErrorResponses } from '../../core/openapi/registry.js';
import { createPermissionBodySchema, permissionResponseSchema } from './dtos/permissions.dto.js';

const tags = ['Permissions'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/permissions',
  tags,
  summary: 'List the full permission catalog',
  description:
    'Intentionally incomplete by design — grows module-by-module as each business module is built (users_roles.md).',
  responses: {
    200: {
      description: 'All permissions',
      ...jsonBody(successEnvelope(z.array(permissionResponseSchema))),
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/permissions',
  tags,
  summary: 'Add a permission to the catalog',
  description:
    'Key must follow the mandatory "module.action" convention, module segment always plural.',
  request: { body: jsonBody(createPermissionBodySchema) },
  responses: {
    201: {
      description: 'Permission created',
      ...jsonBody(successEnvelope(permissionResponseSchema)),
    },
    ...commonErrorResponses,
    409: {
      description: 'Permission key already exists',
      content: {
        'application/json': {
          schema: z.object({ status: z.literal(false), message: z.string(), code: z.literal(409) }),
        },
      },
    },
  },
});
