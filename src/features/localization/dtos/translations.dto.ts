import { z } from 'zod';

/**
 * `GET /:code/translations` response — the full current key→value map for one
 * language (whole-file model, no `since`/delta param — see
 * docs/reference/dynamic_localization.md §8, Model 2 first-version scope).
 */
export const translationsResponseSchema = z.object({
  code: z.string(),
  version: z.number().int(),
  translations: z.record(z.string()),
});

export interface WireTranslations {
  code: string;
  version: number;
  translations: Record<string, string>;
}

/**
 * `PUT /:code/translations` body — replaces/upserts the given key→value
 * pairs for the language (partial map: only listed keys are touched, existing
 * keys not listed are left as-is). Any successful call bumps
 * `languages.version` by 1 — see localization.service.ts.
 */
export const replaceTranslationsBodySchema = z.object({
  translations: z.record(z.string().max(5000)).refine((obj) => Object.keys(obj).length > 0, {
    message: 'translations must contain at least one key',
  }),
});
export type ReplaceTranslationsBody = z.infer<typeof replaceTranslationsBodySchema>;
