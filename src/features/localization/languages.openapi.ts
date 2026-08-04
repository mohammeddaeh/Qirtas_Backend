import { z } from 'zod';
import { registry, successEnvelope, commonErrorResponses } from '../../core/openapi/registry.js';
import {
  languageCodeParamsSchema,
  createLanguageBodySchema,
  updateLanguageBodySchema,
  languageResponseSchema,
} from './dtos/languages.dto.js';
import { replaceTranslationsBodySchema, translationsResponseSchema } from './dtos/translations.dto.js';

const tags = ['Localization'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/languages',
  tags,
  summary: 'List active dynamic languages',
  description:
    'Lightweight "what is available and what version" check the app polls on startup — ar/en are compile-time and never appear here (docs/reference/dynamic_localization.md, Model 2). Unpaginated, mirrors identity\'s GET /permissions (small reference list).',
  responses: {
    200: {
      description: 'Active languages',
      ...jsonBody(successEnvelope(z.array(languageResponseSchema))),
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/languages/{code}/translations',
  tags,
  summary: 'Get the full translation map for one language',
  description:
    'Whole-file model, not incremental sync (no `since` param in this first version). 404 if the code is unknown or the language is deactivated.',
  request: { params: languageCodeParamsSchema },
  responses: {
    200: {
      description: 'Full key -> value translation map',
      ...jsonBody(successEnvelope(translationsResponseSchema)),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/languages/{code}',
  tags,
  summary: 'Get a single language (admin — includes inactive)',
  request: { params: languageCodeParamsSchema },
  responses: {
    200: { description: 'The language', ...jsonBody(successEnvelope(languageResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/languages',
  tags,
  summary: 'Add a new dynamic language',
  description: 'Requires `localization.manage`. ar/en must never be created through this endpoint.',
  request: { body: jsonBody(createLanguageBodySchema) },
  responses: {
    201: { description: 'Language created', ...jsonBody(successEnvelope(languageResponseSchema)) },
    ...commonErrorResponses,
    409: {
      description: 'Language code already exists',
      content: {
        'application/json': {
          schema: z.object({ status: z.literal(false), message: z.string(), code: z.literal(409) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/languages/{code}',
  tags,
  summary: "Update a language's display name/direction",
  request: { params: languageCodeParamsSchema, body: jsonBody(updateLanguageBodySchema) },
  responses: {
    200: { description: 'Language updated', ...jsonBody(successEnvelope(languageResponseSchema)) },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/languages/{code}/translations',
  tags,
  summary: 'Upsert translation entries for a language',
  description:
    'Partial map: only the given keys are added/updated, existing keys not listed are left untouched. Always bumps `languages.version` by 1 on success — the cache-invalidation signal GET /languages exposes.',
  request: { params: languageCodeParamsSchema, body: jsonBody(replaceTranslationsBodySchema) },
  responses: {
    200: {
      description: 'Translations upserted, returns the language with its bumped version',
      ...jsonBody(successEnvelope(languageResponseSchema)),
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/languages/{code}/deactivate',
  tags,
  summary: 'Deactivate a language (soft — no hard delete)',
  description:
    'Sets is_active=false. The app treats a deactivated language exactly like an unknown code (404 on GET /:code/translations).',
  request: { params: languageCodeParamsSchema },
  responses: {
    200: { description: 'Language deactivated', ...jsonBody(successEnvelope(languageResponseSchema)) },
    ...commonErrorResponses,
  },
});
