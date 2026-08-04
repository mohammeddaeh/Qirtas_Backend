import { z } from 'zod';
import type { LanguageRow } from '../schemas/languages.schema.js';

/** Mirrors WireLanguage below for OpenAPI doc generation only — see identity's users.dto.ts for the pattern. */
export const languageResponseSchema = z.object({
  code: z.string(),
  name: z.string(),
  is_rtl: z.boolean(),
  version: z.number().int(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface WireLanguage {
  code: string;
  name: string;
  is_rtl: boolean;
  version: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function toWireLanguage(row: LanguageRow): WireLanguage {
  return {
    code: row.code,
    name: row.name,
    is_rtl: row.is_rtl,
    version: row.version,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Language code convention: lowercase ISO-639-ish, e.g. "fr", "fr-ca". */
export const languageCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2}(-[a-z]{2,4})?$/, 'Language code must look like "fr" or "fr-ca"');

export const languageCodeParamsSchema = z.object({
  code: languageCodeSchema,
});

export const createLanguageBodySchema = z.object({
  code: languageCodeSchema,
  name: z.string().trim().min(1).max(100),
  is_rtl: z.boolean().default(false),
});
export type CreateLanguageBody = z.infer<typeof createLanguageBodySchema>;

export const updateLanguageBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  is_rtl: z.boolean().optional(),
});
export type UpdateLanguageBody = z.infer<typeof updateLanguageBodySchema>;
