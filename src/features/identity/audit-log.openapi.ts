import {
  registry,
  successEnvelope,
  paginatedSchema,
  commonErrorResponses,
} from '../../core/openapi/registry.js';
import { auditLogQuerySchema, auditLogEntryResponseSchema } from './dtos/audit-log-entries.dto.js';

const tags = ['Audit Log'];

registry.registerPath({
  method: 'get',
  path: '/api/v1/audit-log',
  tags,
  summary: 'List audit log entries (paginated), optionally filtered by user or target entity',
  description:
    'Mandatory entry for any action on a Permission.isSensitive=true permission (role/permission edits, financial access, critical deletes).',
  request: { query: auditLogQuerySchema },
  responses: {
    200: {
      description: 'Paginated audit log',
      content: {
        'application/json': {
          schema: successEnvelope(paginatedSchema(auditLogEntryResponseSchema)),
        },
      },
    },
    ...commonErrorResponses,
  },
});
