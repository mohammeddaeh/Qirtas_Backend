import { z } from 'zod';
import type { PermissionRow } from '../schemas/permissions.schema.js';

/** Mirrors WirePermission below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const permissionResponseSchema = z.object({
  key: z.string(),
  module: z.string(),
  is_sensitive: z.boolean(),
  created_at: z.string(),
});

export interface WirePermission {
  key: string;
  module: string;
  is_sensitive: boolean;
  created_at: string;
}

export function toWirePermission(row: PermissionRow): WirePermission {
  return {
    key: row.key,
    module: row.module,
    is_sensitive: row.is_sensitive,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * `module.action`, module segment always plural (users_roles.md — Naming
 * Convention, 2026-07-09), with **any number of intermediate scope segments**:
 * `orders.create`, `printing.queue.view`, `customization.proof.approve`.
 *
 * ── Why it accepts more than two segments ──────────────────────────────────
 * It used to demand exactly two, and **nine of the twenty-six keys in the
 * seeded catalogue have three** — `reports.financial.view`,
 * `printing.queue.view`, `customization.proof.approve`, `orders.delivery.*`
 * and the rest. The seed writes them straight through the repository, so
 * nothing ever validated them; the API then refused the very keys its own
 * catalogue serves.
 *
 * The damage was not limited to creating roles with those permissions.
 * `updateRolePermissionsBodySchema` uses this same schema, so **saving the
 * permissions of an existing role that already held one of them failed with a
 * 422** — including "مدير الفرع", which holds five. Pressing save while
 * changing nothing was enough.
 *
 * The rule this expresses is what the convention always meant: lowercase,
 * dot-separated, at least a module and an action, no empty segments.
 */
export const permissionKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    'Permission key must follow the "module.action" convention (dot-separated, lowercase)',
  );

/** ar/en display name for a catalogue entry — both required, neither may be blank. */
const bilingualNameSchema = z.object({
  ar: z.string().trim().min(1).max(200),
  en: z.string().trim().min(1).max(200),
});

/**
 * ── Why `display` is REQUIRED here ─────────────────────────────────────────
 * The seed has always required it (`SeedPermission.display`), this endpoint
 * never asked for it at all, and both create the same row. So a permission born
 * through the API had no `permission.<key>` translation entry and rendered as
 * the raw-key heuristic — "Warehouse Manage" — in every locale, forever, with
 * nothing anywhere reporting a problem.
 *
 * Making it required rather than optional-with-a-fallback is the point: a
 * fallback is what made this invisible. The display name is not decoration on a
 * permission, it is the only form of it a human ever sees.
 *
 * `module_display` is conditionally required — see the refine below.
 */
export const createPermissionBodySchema = z
  .object({
    key: permissionKeySchema,
    module: z.string().trim().min(1).max(60),
    is_sensitive: z.boolean().default(false),
    display: bilingualNameSchema,
    /**
     * Required only when `module` is one no existing permission uses yet.
     * The app groups a person's permissions by module and labels each group
     * from `permission.module.<module>`; a new module without one produces an
     * untranslated header for every user in every language.
     *
     * Presence is validated here; the "is this module actually new?" question
     * needs the database and is answered in the service.
     */
    module_display: bilingualNameSchema.optional(),
  })
  .refine((b) => b.key.startsWith(`${b.module}.`), {
    message: 'key must start with "<module>." — the module segment and the module field must agree',
    path: ['key'],
  });
export type CreatePermissionBody = z.infer<typeof createPermissionBodySchema>;
