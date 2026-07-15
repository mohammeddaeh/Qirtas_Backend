import { z } from 'zod';
import type { UserRow } from '../schemas/users.schema.js';

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
  is_active: z.boolean(),
  is_admin: z.boolean(),
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
  is_active: boolean;
  is_admin: boolean;
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
    is_active: row.is_active,
    is_admin: row.is_admin,
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

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(255);

/**
 * Self-registration — the single entry point for every internal account.
 * account_type discriminates the branch: customer registration is handled by
 * the (future) storefront/customer feature, not this module.
 */
export const registerStaffBodySchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  phone: z.string().trim().min(1).max(32),
  password: passwordSchema,
  requested_role_id: z.coerce.number().int().positive(),
  requested_branch_id: z.coerce.number().int().positive().nullable().optional(),
  requested_ownership_percentage: z.coerce.number().min(0.01).max(100).optional(),
});
export type RegisterStaffBody = z.infer<typeof registerStaffBodySchema>;

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
  phone: z.string().trim().min(1).max(32),
  password: passwordSchema,
});
export type BootstrapSuperAdminBody = z.infer<typeof bootstrapSuperAdminBodySchema>;

export const suspendUserBodySchema = z.object({
  reason: z.string().trim().max(2000).optional(),
});
export type SuspendUserBody = z.infer<typeof suspendUserBodySchema>;

/** Mirrors LoginResult (services/users.service.ts) for OpenAPI doc generation only. */
export const loginResponseSchema = z.object({
  user: userResponseSchema,
  session_id: z.number().int(),
});
