import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

/**
 * Single shared registry every feature's `*.openapi.ts` file registers its
 * paths/schemas into. Built once at module load, read by
 * `src/core/openapi/document.ts` to generate the final OpenAPI JSON — no
 * hand-written duplicate of the DTOs, this reads the same zod schemas the
 * validate() middleware already uses at runtime.
 */
export const registry = new OpenAPIRegistry();

export const successEnvelope = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    status: z.literal(true).openapi({ example: true }),
    message: z.string().openapi({ example: 'OK' }),
    data: dataSchema,
  });

export const errorEnvelope = z.object({
  status: z.literal(false).openapi({ example: false }),
  message: z.string(),
  code: z.number(),
  errors: z.record(z.array(z.string())).optional(),
});

export const paginatedSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    total_pages: z.number().int(),
  });

/** Standard error responses attached to every registered path (401 only added where the actor is required). */
export const commonErrorResponses = {
  422: {
    description: 'Validation failed',
    content: { 'application/json': { schema: errorEnvelope } },
  },
  404: {
    description: 'Resource not found',
    content: { 'application/json': { schema: errorEnvelope } },
  },
} as const;

export const unauthorizedResponse = {
  401: {
    description: 'Authentication required (actor not resolved — see auth.stub.ts)',
    content: { 'application/json': { schema: errorEnvelope } },
  },
} as const;
