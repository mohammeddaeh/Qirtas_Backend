import { z } from 'zod';
import type { UserRow } from '../schemas/users.schema.js';
import {
  syrianPhoneSchema,
  optionalSyrianPhoneSchema,
  queryBooleanSchema,
} from '../../../core/validation/common-schemas.js';
import { passwordSchema } from '../../../core/auth/services/password.service.js';

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
  email_verified: z.boolean(),
  email_verified_at: z.string().nullable(),
  status: z.enum([
    'pending_approval',
    'active',
    'suspended',
    'rejected',
    'disabled',
    'pending_verification',
  ]),
  rejection_reason: z.string().nullable(),
  requested_role_id: z.number().int().nullable(),
  requested_branch_id: z.number().int().nullable(),
  requested_ownership_percentage: z.number().nullable(),
  submitted_at: z.string(),
  decided_at: z.string().nullable(),
  decided_by_user_id: z.number().int().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  is_deletable: z.boolean().optional(),
  is_archivable: z.boolean().optional(),
  open_assignments_count: z.number().int().optional(),
  assignments_ever_count: z.number().int().optional(),
  audit_entries_count: z.number().int().optional(),
  /** List responses only — see `WireUser.current_posts`. */
  current_posts: z
    .array(
      z.object({
        role_id: z.number().int(),
        role_name: z.string(),
        branch_id: z.number().int().nullable(),
        branch_name: z.string().nullable(),
      }),
    )
    .optional(),
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
  /**
   * Whether the address has been proven.
   *
   * Sent alongside the timestamp rather than instead of it: the client asks a
   * yes/no question ("do I route to the code screen?") and should not have to
   * restate `email_verified_at != null` to answer it — a derivation every
   * caller would repeat, and one of them would get wrong. The timestamp stays
   * for the screens that show *when*.
   */
  email_verified: boolean;
  email_verified_at: string | null;
  status:
    | 'pending_approval'
    | 'active'
    | 'suspended'
    | 'rejected'
    | 'disabled'
    | 'pending_verification';
  rejection_reason: string | null;
  requested_role_id: number | null;
  requested_branch_id: number | null;
  requested_ownership_percentage: number | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by_user_id: number | null;
  /**
   * When this account was retired from view, or null while it is on the books.
   *
   * Sent on every user, list included, because it is a plain column and a
   * client holding an archived record from any route has no other way to know
   * it. Always accompanied by `status: 'disabled'` — archiving writes both, so
   * sign-in has exactly one gate and this is not it.
   */
  archived_at: string | null;
  created_at: string;

  /**
   * Whether this account can be destroyed — nothing has EVER been recorded
   * against it: no assignment, no ownership, and no audit entry it authored.
   *
   * The last condition is the one that decides most cases, and it is invisible
   * on screen: `audit_log_entries.user_id` is `RESTRICT`, so a person who ever
   * signed in has an entry to their name and can never be hard-deleted. What
   * this really identifies is an account created by mistake and never used.
   * `GET /:id` only — each field below is an aggregate.
   */
  is_deletable?: boolean;

  /**
   * Whether this account can be archived — holds no open assignment and no open
   * ownership, is not root-protected.
   *
   * The exit for everyone [is_deletable] excludes, which is nearly everybody.
   */
  is_archivable?: boolean;

  /** Open assignments — what archiving is blocked by. End or transfer them first. */
  open_assignments_count?: number;
  /** Assignment rows ever, open and closed — what deletion is blocked by. */
  assignments_ever_count?: number;
  /**
   * Audit entries this person performed.
   *
   * Sent so the refusal can name the real reason. An account with zero
   * assignments looks obviously deletable to a reader, and is not if it once
   * signed in — without this number the screen could only say "cannot delete"
   * and leave them re-checking a staff list that was never the obstacle.
   */
  audit_entries_count?: number;

  /**
   * Where this person currently works — role plus branch, one entry per active
   * assignment. **List responses only** (`GET /users`); absent elsewhere.
   *
   * Exists because a name alone cannot answer the question every "pick a
   * person" screen actually asks. Choosing "أحمد" to fill a post is a different
   * decision depending on whether he holds nothing, or is the cashier in
   * another branch you are about to pull him out of — and the picker had no way
   * to tell the two apart.
   *
   * An empty array is a real answer (belongs nowhere), which is why it is sent
   * as `[]` rather than omitted: `undefined` would mean "this response does not
   * carry posts", and a client cannot render "بلا منصب" from that.
   */
  current_posts?: WireUserPost[];
}

/** A compact assignment: only what a picker row needs to be readable. */
export interface WireUserPost {
  role_id: number;
  role_name: string;
  /** `null` = unrestricted — every branch, not "unknown". */
  branch_id: number | null;
  branch_name: string | null;
}

/** The `GET /:id`-only verdicts and counts — see the fields on [WireUser] for what each decides. */
export interface UserRetirementFacts {
  is_deletable: boolean;
  is_archivable: boolean;
  open_assignments_count: number;
  assignments_ever_count: number;
  audit_entries_count: number;
}

/** Row -> wire. Never includes password_hash/reset tokens. */
export function toWireUser(row: UserRow, facts?: UserRetirementFacts): WireUser {
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
    email_verified: row.email_verified_at !== null,
    email_verified_at: row.email_verified_at ? row.email_verified_at.toISOString() : null,
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
    archived_at: row.archived_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    // Spread whole or omitted: a list row reporting `open_assignments_count: 0`
    // would be asserting an unstaffed person when nobody asked the question.
    ...(facts ?? {}),
  };
}

export const userIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// `passwordSchema` moved to `core/auth/services/password.service.ts`
// (2026-08-11) and is imported at the top of this file.
//
// It used to be defined here, which meant the password policy was owned by ONE
// feature's DTO file while five endpoints across two features enforced it — and
// a second feature needing a password would have had either to import another
// feature's DTOs (forbidden by the dependency rules) or to restate the regexes,
// which is how two "identical" policies start diverging.
//
// The rules themselves are unchanged: at least 8 characters (now configurable
// via PASSWORD_MIN_LENGTH), at least one letter, at least one digit — still
// matching the app's own `CustomRegex.passwordRegex`. The client-side check
// remains a courtesy; the server's is the only boundary
// (production_readiness.md §A4).

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

// ── Password reset & change ─────────────────────────────────────────────────
//
// The three schemas that lived here moved to `features/auth/dtos/auth.dto.ts`
// (2026-08-11) with their endpoints. They are re-exported below rather than
// duplicated, so the deprecated `/users/*` routes validate against the exact
// same shapes the `/auth/*` routes do.
//
// One deliberate contract change came with the move: reset-password's field is
// now `code`, not `token`. It was never a token — it is a six-digit string a
// person reads off a screen and types, and calling it a token invited
// clients to treat it as opaque and long. The deprecated route accepts both
// spellings (see auth.routes.ts / users.routes.ts) so no shipped client breaks.

export {
  forgotPasswordBodySchema,
  resetPasswordBodySchema,
  changePasswordBodySchema,
  type ForgotPasswordBody,
  type ResetPasswordBody,
  type ChangePasswordBody,
} from '../../auth/dtos/auth.dto.js';

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

/**
 * Mirrors LoginResult (services/users.service.ts) for OpenAPI doc generation only.
 *
 * ⚠️ **`is_super_admin` was missing here while the service sent it** (found
 * 2026-08-17). Nothing failed: this schema feeds `/openapi.json` and nothing
 * else, so the field travelled on every login while the published contract
 * denied it existed — and `LoginModel` on the Flutter side reads it. A client
 * generated from this document, or a reviewer trusting it, would have dropped
 * the one flag that decides whether admin controls render at all.
 *
 * A doc-only schema drifting is silent by construction: `tsc` does not compare
 * it to the service's return type, and no test parsed it. `test/wire_contract_test.dart`
 * on the app side now asserts the shipped shape.
 */
export const loginResponseSchema = z.object({
  user: userResponseSchema,
  token: z.string(),
  session_id: z.number().int(),
  permission_keys: z.array(z.string()),
  is_super_admin: z.boolean(),
});

/** Mirrors CurrentUserResult (services/users.service.ts) for OpenAPI doc generation only — same as loginResponseSchema minus token/session_id. */
export const currentUserResponseSchema = z.object({
  user: userResponseSchema,
  permission_keys: z.array(z.string()),
  is_super_admin: z.boolean(),
  /** Debug builds only — see [CurrentUserResult.declared_keys]. Absent in release. */
  declared_keys: z.array(z.string()).optional(),
});

/** See docs/rest_api.md §6.1 Filtering & Sorting — merged with paginationQuerySchema at the route. */
export const usersFilterQuerySchema = z
  .object({
    status: z.enum([
    'pending_approval',
    'active',
    'suspended',
    'rejected',
    'disabled',
    'pending_verification',
  ]).optional(),
    is_admin: queryBooleanSchema.optional(),
    /**
     * Archived accounts are excluded unless this asks for them, and `true`
     * returns ONLY archived accounts.
     *
     * Not covered by `status`: archiving forces `disabled`, so without this
     * every retired account would reappear the moment someone filtered by
     * "معطَّل" — the one filter an admin uses to review who is off the books.
     */
    archived: queryBooleanSchema.optional(),
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
     * Excludes whoever already holds this exact post — role
     * [excluding_role_id] in branch [excluding_branch_id].
     *
     * The pair, never either half alone. "Who can fill this post" must not
     * exclude everyone who holds the role *somewhere else* (they are precisely
     * the qualified transfers), nor everyone in the branch (they can take a
     * second, different role there). Only the people for whom the assignment
     * would be a duplicate — which the backend answers with `409
     * assignment_duplicate` — are the ones with nothing to offer.
     *
     * Replaces `unassigned=true` as the picker's filter. That one showed only
     * people who belong nowhere, which in a staffed organisation is a nearly
     * empty list, and it hid every legitimate transfer candidate.
     */
    excluding_role_id: z.coerce.number().int().positive().optional(),
    /**
     * The branch half of the pair. **Absent means the unrestricted post**
     * (`branch_id IS NULL`), not "any branch" — an unrestricted assignment is a
     * real post that a person can duplicate like any other. Ignored unless
     * [excluding_role_id] is present, so it can never silently widen a filter
     * on its own.
     */
    excluding_branch_id: z.coerce.number().int().positive().optional(),
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

/**
 * `GET /users/me?include_declared=true` adds every key this server enforces.
 *
 * Requested only by debug builds — see [CurrentUserResult.declared_keys] for
 * what it protects against (a mistyped key in the app produces a control hidden
 * from everyone, forever, with no error anywhere).
 */
export const currentUserQuerySchema = z.object({
  include_declared: queryBooleanSchema.optional(),
});
