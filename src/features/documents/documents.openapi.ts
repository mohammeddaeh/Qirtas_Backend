import { z } from 'zod';
import { registry, successEnvelope, commonErrorResponses } from '../../core/openapi/registry.js';
import { idParamsSchema } from '../catalog/dtos/common.dto.js';
import {
  contextQuerySchema,
  createTemplateBodySchema,
  labelsBodySchema,
  profileBodySchema,
  templatesQuerySchema,
  updateTemplateBodySchema,
} from './dtos/documents.dto.js';

/**
 * الفواتير والملصقات بالوثائق المولَّدة — الأشكال كاملةً بـ`docs/rest_api.md` §32.
 */

const tags = ['Documents'];
const shape = z.object({}).passthrough();
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: successEnvelope(schema) } },
});
const READ = 'Requires one of `documents.templates`, `sales.sell`, `sales.refund`, `barcodes.print`.';
const DESIGN = 'Requires `documents.templates`.';

registry.registerPath({
  method: 'get',
  path: '/api/v1/documents/context',
  tags,
  summary: 'Profile, branch and the default template of each kind — everything a device renders from',
  description: READ,
  request: { query: contextQuerySchema },
  responses: { 200: ok('Context', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/documents/templates',
  tags,
  summary: 'Templates, default first then ready-made',
  description: READ,
  request: { query: templatesQuerySchema },
  responses: { 200: ok('Templates', z.array(shape)), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/documents/templates/{id}',
  tags,
  summary: 'One template',
  description: READ,
  request: { params: idParamsSchema },
  responses: { 200: ok('Template', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/documents/templates',
  tags,
  summary: 'Create a template, from a layout or as a copy',
  description: `${DESIGN} The layout is validated for its kind and stored with every default filled; a bad one is 422 under \`layout.\`.`,
  request: { body: { content: { 'application/json': { schema: createTemplateBodySchema } } } },
  responses: { 201: ok('Template', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/documents/templates/{id}',
  tags,
  summary: 'Rename or re-lay a template',
  description: `${DESIGN} Ready-made templates are 409 \`document_template_is_system\` — copy them.`,
  request: {
    params: idParamsSchema,
    body: { content: { 'application/json': { schema: updateTemplateBodySchema } } },
  },
  responses: { 200: ok('Template', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/documents/templates/{id}/default',
  tags,
  summary: 'Make this the default of its kind',
  description: `${DESIGN} Returns every template of the kind — the flag moved off another row.`,
  request: { params: idParamsSchema },
  responses: { 200: ok('Templates', z.array(shape)), ...commonErrorResponses },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/documents/templates/{id}',
  tags,
  summary: 'Delete a copy',
  description: `${DESIGN} Hard delete: nothing references a template, and the audit log keeps it. Ready-made (409 \`document_template_is_system\`) and default (409 \`document_template_is_default\`) templates are refused.`,
  request: { params: idParamsSchema },
  responses: { 200: ok('Deleted', z.null()), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/documents/profile',
  tags,
  summary: 'The shop profile printed on every receipt',
  description: READ,
  responses: { 200: ok('Profile', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/documents/profile',
  tags,
  summary: 'Replace the shop profile',
  description: `${DESIGN} Every field is written — an emptied field is sent \`null\`.`,
  request: { body: { content: { 'application/json': { schema: profileBodySchema } } } },
  responses: { 200: ok('Profile', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/documents/logo',
  tags,
  summary: 'Upload a logo image (multipart `file`)',
  description: `${DESIGN} Returns the image; it is kept once \`PUT /profile\` names it.`,
  responses: { 201: ok('Image', shape), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/documents/labels',
  tags,
  summary: 'What each label prints — name, code and the price at this branch',
  description:
    'Requires `barcodes.print`. The price is the till price (offers applied) times the unit factor; `status` other than `priced` has no amount.',
  request: { body: { content: { 'application/json': { schema: labelsBodySchema } } } },
  responses: { 200: ok('Labels', z.array(shape)), ...commonErrorResponses },
});
