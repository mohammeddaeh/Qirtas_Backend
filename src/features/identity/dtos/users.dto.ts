import { z } from 'zod';
import type { UserRow } from '../schemas/users.schema.js';
import {
  syrianPhoneSchema,
  optionalSyrianPhoneSchema,
  queryBooleanSchema,
} from '../../../core/validation/common-schemas.js';

/**
 * Mirrors WireUser below for OpenAPI doc generation only (zod-to-openapi
 * needs an actual zod schema, not a TS interface) — keep both in sync when
 * either changes. Runtime code always uses toWireUser()/WireUser, never this.
 */
export const userResponseSchema = z.object({
  id: z.number().int(),
  first_name: z.string(),
  last_name: z.string(),
  full_name: z.string(),
  email: z.string().email(),
  phone: z.string(),
  image: z.string().nullable(),
  address: z.string().nullable(),
  is_admin: z.boolean(),
  is_root_protected: z.boolean(),
  mfa_enabled: z.boolean(),
  status: z.enum(['pending_approval', 'active', 'suspended', 'rejected', 'disabled']),
  rejection_reason: z.string().nullable(),
  requested_role_id: z.number().int().nullable(),
  requested_branch_id: z.number().int().nullable(),
  requested_ownership_percentage: z.number().nullable(),
  submitted_at: z.string(),
  decided_at: z.string().nullable(),
  decided_by_user_id: z.number().int().nullable(),
  created_at: z.string(),
});

export interface WireUser {
  id: number;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  phone: string;
  image: string | null;
  address: string | null;
  is_admin: boolean;
  is_root_protected: boolean;
  mfa_enabled: boolean;
  status: 'pending_approval' | 'active' | 'suspended' | 'rejected' | 'disabled';
  rejection_reason: string | null;
  requested_role_id: number | null;
  requested_branch_id: number | null;
  requested_ownership_percentage: number | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by_user_id: number | null;
  created_at: string;
}

/** Row -> wire. Never includes password_hash/reset tokens. */
export function toWireUser(row: UserRow): WireUser {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    full_name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    phone: row.phone,
    image: row.image,
    address: row.address,
    is_admin: row.is_admin,
    is_root_protected: row.is_root_protected,
    mfa_enabled: row.mfa_enabled,
    status: row.status,
    rejection_reason: row.rejection_reason,
    requested_role_id: row.requested_role_id,
    requested_branch_id: row.requested_branch_id,
    requested_ownership_percentage:
      row.requested_ownership_percentage === null
        ? null
        : Number(row.requested_ownership_percentage),
    submitted_at: row.submitted_at.toISOString(),
    decided_at: row.decided_at ? row.decided_at.toISOString() : null,
    decided_by_user_id: row.decided_by_user_id,
    created_at: row.created_at.toISOString(),
  };
}

export const userIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Mirrors the app's own rule (`CustomRegex.passwordRegex`, qirtas_app
 * core/foundation/utils/validators.dart): at least 8 characters, containing at
 * least one letter and one digit.
 *
 * The client-side check is a courtesy, not a boundary — until this matched it,
 * `"aaaaaaaa"` was accepted from curl, Postman, or any future client, and the
 * only rule that actually holds is the server's (production_readiness.md §A4).
 * If the app's regex changes, change this one in the same commit.
 */
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(255)
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/\d/, 'Password must contain at least one digit');

/**
 * Self-registration — the single entry point for every internal account.
 * account_type discriminates the branch: customer registration is handled by
 * the (future) storefront/customer feature, not this module.
 */
export const registerStaffBodySchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  phone: syrianPhoneSchema,
  password: passwordSchema,
  requested_role_id: z.coerce.number().int().positive(),
  requested_branch_id: z.coerce.number().int().positive().nullable().optional(),
  requested_ownership_percentage: z.coerce.number().min(0.01).max(100).optional(),
});
export type RegisterStaffBody = z.infer<typeof registerStaffBodySchema>;

/**
 * Admin-direct creation — distinct from registerStaffBodySchema above.
 * `/register` is self-service + later admin review (decide-registration);
 * this is an admin creating a fully-active account for someone else in one
 * step, with the role already assigned (required, not just "requested") —
 * the admin issuing this call IS the approval, by definition. Never conflate
 * the two flows or their endpoints.
 */
export const createUserByAdminBodySchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  phone: syrianPhoneSchema,
  password: passwordSchema,
  role_id: z.coerce.number().int().positive(),
  branch_id: z.coerce.number().int().positive().nullable().optional(),
  ownership_percentage: z.coerce.number().min(0.01).max(100).optional(),
});
export type CreateUserByAdminBody = z.infer<typeof createUserByAdminBodySchema>;

/** Admin decision on a pending_approval account — accept as-is, accept with edits, or reject. */
export const decideRegistrationBodySchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approve'),
    role_id: z.coerce.number().int().positive().optional(),
    branch_id: z.coerce.number().int().positive().nullable().optional(),
    ownership_percentage: z.coerce.number().min(0.01).max(100).optional(),
  }),
  z.object({
    decision: z.literal('reject'),
    reason: z.string().trim().min(1).max(2000),
  }),
]);
export type DecideRegistrationBody = z.infer<typeof decideRegistrationBodySchema>;

/**
 * Resubmission after a rejection — same request shape as registerStaffBodySchema
 * minus identity/password fields (those don't change on resubmit, only the
 * requested role/branch/ownership%). Caller is identified by their session
 * (req.user), not by body/params.
 */
export const resubmitRegistrationBodySchema = z.object({
  requested_role_id: z.coerce.number().int().positive(),
  requested_branch_id: z.coerce.number().int().positive().nullable().optional(),
  requested_ownership_percentage: z.coerce.number().min(0.01).max(100).optional(),
});
export type ResubmitRegistrationBody = z.infer<typeof resubmitRegistrationBodySchema>;

export const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  device_info: z.string().trim().max(500).optional(),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

/** First-run bootstrap — only callable while zero User rows exist (see setup wizard flow). */
export const bootstrapSuperAdminBodySchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  phone: syrianPhoneSchema,
  password: passwordSchema,
});
export type BootstrapSuperAdminBody = z.infer<typeof bootstrapSuperAdminBodySchema>;

export const suspendUserBodySchema = z.object({
  reason: z.string().trim().max(2000).optional(),
});
export type SuspendUserBody = z.infer<typeof suspendUserBodySchema>;

/**
 * Edits identity/profile fields only — status/is_admin/password each have
 * their own dedicated endpoint (suspend/disable/reactivate/decide-registration
 * for status; password change is a separate, out-of-scope flow) and are
 * never touched here.
 */
export const updateUserBodySchema = z.object({
  first_name: z.string().trim().min(1).max(100).optional(),
  last_name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  phone: optionalSyrianPhoneSchema,
});
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

/** Mirrors LoginResult (services/users.service.ts) for OpenAPI doc generation only. */
export const loginResponseSchema = z.object({
  user: userResponseSchema,
  token: z.string(),
  session_id: z.number().int(),
  permission_keys: z.array(z.string()),
});

/** Mirrors CurrentUserResult (services/users.service.ts) for OpenAPI doc generation only — same as loginResponseSchema minus token/session_id. */
export const currentUserResponseSchema = z.object({
  user: userResponseSchema,
  permission_keys: z.array(z.string()),
});

/** See docs/rest_api.md §6.1 Filtering & Sorting — merged with paginationQuerySchema at the route. */
export const usersFilterQuerySchema = z
  .object({
    status: z.enum(['pending_approval', 'active', 'suspended', 'rejected', 'disabled']).optional(),
    is_admin: queryBooleanSchema.optional(),
    requested_role_id: z.coerce.number().int().positive().optional(),
    /**
     * `true` → only users holding NO active assignment; `false` → only users
     * who hold at least one. These are the people who exist in the system but
     * belong to no branch and carry no role, so they are exactly the candidates
     * for staffing an empty branch — and the subject of the dashboard's
     * `user_unassigned` signal, which had no way to be listed before this.
     */
    unassigned: queryBooleanSchema.optional(),
    /**
     * Free-text match across full name, email and phone.
     *
     * A staff directory becomes unusable by scrolling long before it becomes
     * large — an admin looking for one person should not page through the
     * organisation. Trimmed, and an all-whitespace value is treated as absent
     * so a stray space never filters everything out.
     */
    search: z
      .string()
      .trim()
      .max(150)
      .optional()
      .transform((v) => (v !== undefined && v.length > 0 ? v : undefined)),
    sort_by: z.enum(['created_at', 'first_name']).default('created_at'),
    sort_dir: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type UsersFilterQuery = z.infer<typeof usersFilterQuerySchema>;
