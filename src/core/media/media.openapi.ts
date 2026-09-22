import { z } from 'zod';
import { registry, commonErrorResponses } from '../openapi/registry.js';
import { privateFileQuerySchema } from './dtos/files.dto.js';

const tags = ['Files'];

registry.registerPath({
  method: 'get',
  path: '/api/v1/files/public/{key}',
  tags,
  summary: 'Download a public file',
  description:
    'Catalog images. No token. `Cache-Control: immutable` — keys are never reused. `key` may contain `/`.',
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: { description: 'File bytes' },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/files/private/{key}',
  tags,
  summary: 'Download a private file through a signed link',
  description:
    'The signature is the authorisation (no token): the server issues the link after checking the reader. ' +
    '403 `file_link_invalid` when expired or tampered with.',
  request: { params: z.object({ key: z.string() }), query: privateFileQuerySchema },
  responses: {
    200: { description: 'File bytes' },
    ...commonErrorResponses,
  },
});
