import { z } from 'zod';
import { isEnforced } from '../registry.js';

/**
 * Request shape for `PUT /users/:id/overrides`.
 *
 * The one rule worth stating: **a key is validated against the registry, not a
 * pattern.** `roles.edti` is a typo that would otherwise be stored happily,
 * match nothing, and present as "I denied it and it still works" weeks later.
 * Here it is a 422 naming the key, at the moment somebody pressed save.
 */
const overrideKeySchema = z
  .string()
  .trim()
  .max(100)
  .refine(isEnforced, (key) => ({
    message: `Unknown permission "${key}" — no route on this server enforces it.`,
  }));

export const replaceOverridesBodySchema = z.object({
  overrides: z
    .array(
      z.object({
        key: overrideKeySchema,
        effect: z.enum(['allow', 'deny']),
        note: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .max(200)
    .refine(
      (list) => new Set(list.map((o) => o.key)).size === list.length,
      'The same permission appears twice — an account cannot be both allowed and denied one key',
    ),
});

export type ReplaceOverridesBody = z.infer<typeof replaceOverridesBodySchema>;

/** Mirrors `WireUserOverrides` for OpenAPI generation only. Keep both in sync. */
export const userOverridesResponseSchema = z.object({
  user_id: z.number().int(),
  overrides: z.array(
    z.object({
      key: z.string(),
      effect: z.enum(['allow', 'deny']),
      note: z.string().nullable(),
      is_stale: z.boolean(),
    }),
  ),
  effective_permissions: z.array(z.string()),
});
