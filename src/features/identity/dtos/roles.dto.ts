import { z } from 'zod';
import type { RoleRow } from '../schemas/roles.schema.js';
import type { RoleHolderRow } from '../repositories/roles.repository.js';
import { queryBooleanSchema } from '../../../core/validation/common-schemas.js';
import {
  permissionKeySchema,
  permissionResponseSchema,
  type WirePermission,
} from './permissions.dto.js';

/** Mirrors WireRole below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const roleResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  category: z.enum(['system', 'management', 'operational', 'financial', 'external']),
  level: z.number().int().nullable(),
  is_system_default: z.boolean(),
  is_active: z.boolean(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  permissions: z.array(permissionResponseSchema).optional(),
  active_holders_count: z.number().int().optional(),
  is_deletable: z.boolean().optional(),
  is_archivable: z.boolean().optional(),
  assignments_ever_count: z.number().int().optional(),
  open_assignments_count: z.number().int().optional(),
});

export interface WireRole {
  id: number;
  name: string;
  category: 'system' | 'management' | 'operational' | 'financial' | 'external';
  level: number | null;
  is_system_default: boolean;
  is_active: boolean;
  /**
   * When this role was retired from the catalogue, or null if it is in it.
   *
   * Sent on every role, list included — it is a plain column, and a client
   * looking at the archived view needs to know that is what it has.
   *
   * Not the same statement as `is_active: false`. A deactivated role is browsed
   * under the list's "معطَّل" filter because reviving it is routine; an archived
   * one is gone from the list entirely.
   */
  archived_at: string | null;
  created_at: string;
  permissions?: WirePermission[];
  /**
   * Distinct active people holding this role right now.
   *
   * Present on `GET /:id` only — the same reason `permissions` is: the list
   * would need one aggregate per row. Editing a role's permissions changes what
   * every holder can do, the instant it is saved, so the count is the size of
   * that consequence and belongs beside the decision rather than in a report
   * nobody opens first.
   */
  active_holders_count?: number;
  /**
   * Whether this role can be hard-deleted — no assignment has EVER referenced
   * it, and it is not a seeded default.
   *
   * Computed by the same rule `deleteRole` enforces, so the client offers the
   * action only where it can succeed instead of offering it everywhere and
   * refusing afterwards. `GET /:id` only, like the fields above.
   */
  is_deletable?: boolean;

  /**
   * Assignment rows that have ever referenced this role — active and ended
   * alike. `GET /:id` only.
   *
   * Sent so the client can say WHY deletion is unavailable instead of hiding
   * the button. "Nobody holds it now" and "nobody ever held it" are different
   * facts, and a role with 0 active but 3 historical assignments looks
   * deletable to a reader and is not. [is_deletable] stays the authority on
   * whether the action is offered; this only chooses the sentence.
   */
  assignments_ever_count?: number;

  /**
   * Whether this role can be archived — held by nobody right now, and not a
   * seeded default.
   *
   * The exit for the case [is_deletable] cannot cover, which is most of them:
   * a role that has ever been assigned can never be deleted, so before this
   * existed a retired job title had no way off the list at all. Computed by the
   * rule `archiveRole` enforces, so the client offers the action exactly where
   * it succeeds. `GET /:id` only.
   */
  is_archivable?: boolean;

  /**
   * Assignment rows still open on this role — the number archiving is blocked
   * by, and NOT the same as [active_holders_count].
   *
   * That one counts distinct people whose account status is `active`, because
   * it measures who is affected by a permission change. This one counts open
   * rows whatever the person's status, because a suspended employee still
   * occupies the post: archiving under them would leave a live assignment
   * pointing at a role the app shows nowhere. Sending only the first would let
   * the screen say "nobody holds this" beside a refusal that says otherwise.
   */
  open_assignments_count?: number;
}

/** The `GET /:id`-only fields, gathered so the call site reads as facts rather than five positional booleans. */
export interface RoleDetailFacts {
  permissions: WirePermission[];
  active_holders_count: number;
  is_deletable: boolean;
  is_archivable: boolean;
  assignments_ever_count: number;
  open_assignments_count: number;
}

export function toWireRole(row: RoleRow, facts?: RoleDetailFacts): WireRole {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    level: row.level,
    is_system_default: row.is_system_default,
    is_active: row.is_active,
    archived_at: row.archived_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    // Omitted wholesale rather than defaulted when not computed: "no holders"
    // and "not asked" are different answers, and a 0 would let a list row claim
    // the former.
    ...(facts ?? {}),
  };
}

/** Mirrors WireRoleHolder for OpenAPI generation only. */
export const roleHolderResponseSchema = z.object({
  assignment_id: z.number().int(),
  user_id: z.number().int(),
  full_name: z.string(),
  email: z.string(),
  user_status: z.string(),
  branch_id: z.number().int().nullable(),
  branch_name: z.string().nullable(),
  valid_from: z.string(),
});

export interface WireRoleHolder {
  assignment_id: number;
  user_id: number;
  full_name: string;
  email: string;
  user_status: string;
  /** Null = unrestricted: they hold the role without being confined to a branch. */
  branch_id: number | null;
  branch_name: string | null;
  valid_from: string;
}

export function toWireRoleHolder(row: RoleHolderRow): WireRoleHolder {
  return {
    assignment_id: row.assignment_id,
    user_id: row.user_id,
    full_name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    user_status: row.user_status,
    branch_id: row.branch_id,
    branch_name: row.branch_name,
    valid_from: row.valid_from.toISOString(),
  };
}

export const roleIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const createRoleBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  category: z.enum(['system', 'management', 'operational', 'financial', 'external']),
  permission_keys: z.array(permissionKeySchema).default([]),
  /**
   * Authority rank — **lower is stronger**, Super Admin is 0. Omit for a role
   * that carries no authority at all (the common case: an operational post).
   *
   * Settable at creation, unlike `PUT /:id/level` which is Super-Admin-only,
   * and the difference is not an inconsistency. `assertActorOutranks` already
   * refuses a level at or above the caller's own, so creating a *subordinate*
   * role is self-limiting. Editing an *existing* role's level is not: the role
   * being edited may be the caller's own, and the check would be passed before
   * the raise it authorises. Hence one gate for each.
   *
   * Before this, `level` was reachable **only** by cloning a role that already
   * had one — so a first hierarchy could never be built at all.
   */
  level: z.number().int().min(0).optional(),
  /** Optional source role to clone permissions from as the starting point. */
  clone_from_role_id: z.coerce.number().int().positive().optional(),
  /** Explicit override to proceed despite an exact-permission-set match warning. */
  force: z.boolean().default(false),
});
export type CreateRoleBody = z.infer<typeof createRoleBodySchema>;

/**
 * Identity edits — name and/or category. `level` is deliberately absent: it
 * has its own Super-Admin-only endpoint (see below), and folding it in here
 * would silently widen that gate to anyone holding `roles.edit`.
 *
 * At least one field must be present; an empty body is a caller mistake, not a
 * no-op worth a 200.
 */
export const updateRoleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    category: z.enum(['system', 'management', 'operational', 'financial', 'external']).optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.category !== undefined, {
    message: 'Provide at least one of: name, category',
  });
export type UpdateRoleBody = z.infer<typeof updateRoleBodySchema>;

export const updateRolePermissionsBodySchema = z.object({
  permission_keys: z.array(permissionKeySchema),
  /**
   * Explicit override for the exact-permission-set warning, exactly as on
   * create.
   *
   * The check ran on `POST /roles` only, so the warning could be raised when a
   * role was born and never again — clone a role, save its permissions
   * untouched, and two roles with identical powers existed with nothing said.
   * The rule is about the resulting state, not about which endpoint produced
   * it.
   */
  force: z.boolean().default(false),
});
export type UpdateRolePermissionsBody = z.infer<typeof updateRolePermissionsBodySchema>;

/** `level` edits are Super Admin-only and go through a dedicated endpoint (see users_roles.md). */
export const updateRoleLevelBodySchema = z.object({
  level: z.number().int().min(0),
});
export type UpdateRoleLevelBody = z.infer<typeof updateRoleLevelBodySchema>;

/** See docs/rest_api.md §6.1 Filtering & Sorting — merged with paginationQuerySchema at the route. */
export const rolesFilterQuerySchema = z
  .object({
    category: z.enum(['system', 'management', 'operational', 'financial', 'external']).optional(),
    is_active: queryBooleanSchema.optional(),
    /** Free-text match on role name. Same contract as `GET /users?search=`. */
    search: z
      .string()
      .trim()
      .max(150)
      .optional()
      .transform((v) => (v !== undefined && v.length > 0 ? v : undefined)),
    /**
     * `true` → only roles the CALLER may actually assign, i.e. strictly below
     * their own authority level (a role with `level = null` carries no
     * authority and is always assignable).
     *
     * Exists so a picker cannot offer a role that `assertActorOutranksRole`
     * will certainly reject: without it the user chooses, submits, and only
     * then learns it was never permitted. The comparison stays here on the
     * server, beside the guard it mirrors, rather than being restated in each
     * client where it would drift out of sync silently.
     */
    assignable: queryBooleanSchema.optional(),
    /**
     * Archived roles are excluded unless this asks for them, and `true` returns
     * ONLY archived roles — the archive is a separate view, not extra rows
     * mixed into the catalogue where nothing marks which is which.
     */
    archived: queryBooleanSchema.optional(),
    sort_by: z.enum(['created_at', 'name', 'level']).default('created_at'),
    sort_dir: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type RolesFilterQuery = z.infer<typeof rolesFilterQuerySchema>;
