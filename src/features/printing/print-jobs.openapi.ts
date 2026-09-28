import { z } from 'zod';
import { registry, successEnvelope, commonErrorResponses } from '../../core/openapi/registry.js';
import {
  addLinkBodySchema,
  cancelJobBodySchema,
  createJobBodySchema,
  deferBodySchema,
  jobFileParamsSchema,
  jobLinkParamsSchema,
  jobParamsSchema,
  queueQuerySchema,
  quoteJobBodySchema,
  reserveFileBodySchema,
  staffCancelBodySchema,
  stageBodySchema,
  updateJobBodySchema,
} from './dtos/print-jobs.dto.js';

/** طلب الطباعة بالوثائق المولَّدة — الأشكال كاملةً بـ`docs/rest_api.md` §30. */

const tags = ['Print jobs'];
const shape = z.object({}).passthrough();
const ok = (description: string) => ({
  description,
  content: { 'application/json': { schema: successEnvelope(shape) } },
});
const body = <T extends z.ZodTypeAny>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

type Method = 'get' | 'post' | 'patch' | 'delete';
const path = (
  method: Method,
  p: string,
  summary: string,
  request: Record<string, unknown> = {},
  status: 200 | 201 = 200,
): void => {
  registry.registerPath({
    method,
    path: p,
    tags,
    summary,
    request,
    responses: { [status]: ok(summary), ...commonErrorResponses },
  });
};

// ── الزبون ──
path('get', '/api/v1/print-jobs', 'My print orders (status may list several, comma-separated)');
path(
  'post',
  '/api/v1/print-jobs',
  'Open a draft print order (verified customer)',
  body(createJobBodySchema),
  201,
);
path('get', '/api/v1/print-jobs/{id}', 'One of my print orders', { params: jobParamsSchema });
path('patch', '/api/v1/print-jobs/{id}', 'Change the spec, copies or note of a draft', {
  params: jobParamsSchema,
  ...body(updateJobBodySchema),
});
path(
  'post',
  '/api/v1/print-jobs/{id}/files',
  'Reserve a file — returns the direct upload link (PUT the exact bytes to it)',
  { params: jobParamsSchema, ...body(reserveFileBodySchema) },
  201,
);
path(
  'post',
  '/api/v1/print-jobs/{id}/files/{fileId}/complete',
  'Confirm an upload — size and type from the bytes',
  {
    params: jobFileParamsSchema,
  },
);
path('delete', '/api/v1/print-jobs/{id}/files/{fileId}', 'Remove a file from a draft', {
  params: jobFileParamsSchema,
});
path('get', '/api/v1/print-jobs/{id}/files/{fileId}/link', 'A 10-minute link to read my file', {
  params: jobFileParamsSchema,
});
path(
  'post',
  '/api/v1/print-jobs/{id}/links',
  'Add an https link to print (stored as text, never fetched)',
  {
    params: jobParamsSchema,
    ...body(addLinkBodySchema),
  },
);
path('delete', '/api/v1/print-jobs/{id}/links/{linkId}', 'Remove a link from a draft', {
  params: jobLinkParamsSchema,
});
path(
  'post',
  '/api/v1/print-jobs/{id}/submit',
  'Send the draft — it gets a number and waits for staff to price it',
  {
    params: jobParamsSchema,
  },
);
path('post', '/api/v1/print-jobs/{id}/cancel', 'Cancel before payment', {
  params: jobParamsSchema,
  ...body(cancelJobBodySchema),
});

// ── الموظف ──
path(
  'post',
  '/api/v1/printing/jobs/{id}/defer',
  'Print before payment, with approval (printing.payment.defer)',
  {
    params: jobParamsSchema,
    ...body(deferBodySchema),
  },
);
path(
  'get',
  '/api/v1/printing/jobs',
  'The branch print queue (printing.queue.view at that branch)',
  {
    query: queueQuerySchema,
  },
);
path('get', '/api/v1/printing/jobs/branches', 'Branches whose print queue the reader may see');
path('get', '/api/v1/printing/jobs/{id}', 'One print order', { params: jobParamsSchema });
path('get', '/api/v1/printing/jobs/{id}/files/{fileId}/link', 'Open a file (audited)', {
  params: jobFileParamsSchema,
});
path(
  'post',
  '/api/v1/printing/jobs/{id}/quote',
  'Enter the page count per copy — the server prices',
  {
    params: jobParamsSchema,
    ...body(quoteJobBodySchema),
  },
);
path(
  'post',
  '/api/v1/printing/jobs/{id}/status',
  'Move to in_production · ready · picked_up (production needs payment)',
  {
    params: jobParamsSchema,
    ...body(stageBodySchema),
  },
);
path(
  'post',
  '/api/v1/printing/jobs/{id}/cancel',
  'Refuse before payment, with a reason the customer sees',
  {
    params: jobParamsSchema,
    ...body(staffCancelBodySchema),
  },
);
