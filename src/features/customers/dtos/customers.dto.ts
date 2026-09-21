import { z } from 'zod';
import { passwordSchema } from '../../../core/auth/services/password.service.js';
import { queryBooleanSchema } from '../../../core/validation/common-schemas.js';
import type { CustomerRow } from '../schemas/customers.schema.js';

const phoneSchema = z.string().trim().min(6).max(32);

/**
 * `POST /customers/register`.
 *
 * Deliberately has no `customer_type`, `status` or `wholesale_*`: every
 * self-registered customer is a retail, active one. Wholesale is a separate,
 * admin-approved step (docs/reference/customer_accounts.md §4) — accepting it
 * here would let a request body promote itself.
 */
export const registerCustomerBodySchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  phone: phoneSchema.optional(),
  password: passwordSchema,
  preferred_branch_id: z.coerce.number().int().positive().nullable().optional(),
  device_info: z.string().trim().max(500).optional(),
});
export type RegisterCustomerBody = z.infer<typeof registerCustomerBodySchema>;

/** `PATCH /customers/me` — only what a person may change about themselves. */
export const updateCustomerProfileBodySchema = z
  .object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    phone: phoneSchema.nullable(),
    address: z.string().trim().max(500).nullable(),
    preferred_branch_id: z.coerce.number().int().positive().nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
export type UpdateCustomerProfileBody = z.infer<typeof updateCustomerProfileBodySchema>;

export interface WireCustomer {
  id: number;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  phone: string | null;
  address: string | null;
  image: string | null;
  status: CustomerRow['status'];
  customer_type: CustomerRow['customer_type'];
  wholesale_status: CustomerRow['wholesale_status'];
  preferred_branch_id: number | null;
  email_verified: boolean;
  email_verified_at: string | null;
  /** When the current wholesale request was filed; null if none. */
  wholesale_requested_at: string | null;
  wholesale_decided_at: string | null;
  /** Why a request was turned down — the customer is owed an answer. */
  wholesale_rejection_reason: string | null;
  /** Retired from the working list; only present for admins asking for the archive. */
  archived_at: string | null;
  created_at: string;
}

export function toWireCustomer(row: CustomerRow): WireCustomer {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    full_name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    phone: row.phone,
    address: row.address,
    image: row.image,
    status: row.status,
    customer_type: row.customer_type,
    wholesale_status: row.wholesale_status,
    preferred_branch_id: row.preferred_branch_id,
    email_verified: row.email_verified_at !== null,
    email_verified_at: row.email_verified_at ? row.email_verified_at.toISOString() : null,
    wholesale_requested_at: row.wholesale_requested_at?.toISOString() ?? null,
    wholesale_decided_at: row.wholesale_decided_at?.toISOString() ?? null,
    wholesale_rejection_reason: row.wholesale_rejection_reason,
    archived_at: row.archived_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

// ── Admin side — `/customers` management (customers.view · customers.manage) ──

export const customerIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** Merged with `paginationQuerySchema` at the route — same shape as `usersFilterQuerySchema`. */
export const customersFilterQuerySchema = z
  .object({
    status: z.enum(['active', 'suspended', 'disabled']).optional(),
    customer_type: z.enum(['retail', 'wholesale']).optional(),
    /** The wholesale queue is `?wholesale_status=pending`. */
    wholesale_status: z.enum(['pending', 'approved', 'rejected']).optional(),
    /** `true` returns ONLY archived customers; the default hides them. */
    archived: queryBooleanSchema.optional(),
    /** `true` → only customers with a proven address; `false` → only unproven. */
    email_verified: queryBooleanSchema.optional(),
    /** Name (first + last, matched together), email or phone. */
    search: z.string().trim().max(100).optional(),
    sort_by: z.enum(['created_at', 'first_name']).default('created_at'),
    sort_dir: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type CustomersFilterQuery = z.infer<typeof customersFilterQuerySchema>;

/** `POST /customers/:id/wholesale/decide` — a rejection must say why. */
export const decideWholesaleBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((v) => v.decision === 'approve' || v.reason !== undefined, {
    message: 'A rejection needs a reason',
    path: ['reason'],
  });
export type DecideWholesaleBody = z.infer<typeof decideWholesaleBodySchema>;

/** One row of `GET /customers/:id/activity`. */
export interface WireCustomerActivity {
  id: number;
  action: string;
  details: unknown;
  ip_address: string | null;
  device_info: string | null;
  created_at: string;
}

/** `DELETE /customers/me` — the password is asked again: a stolen unlocked phone must not be able to erase the account. */
export const deleteMeBodySchema = z.object({
  password: z.string().min(1),
});
export type DeleteMeBody = z.infer<typeof deleteMeBodySchema>;

// ── Contact policy ───────────────────────────────────────────────────────────
//
// A customer's email and phone are personal data, and the customer directory is
// chain-wide (a customer belongs to no branch). `customers.view` lets someone
// work the list; only `customers.contact` lets them read HOW TO REACH people.
// Everyone else sees enough to recognise a row (name, status, the shape of the
// address) and not enough to copy it.

/** `laila@qirtas.test` → `l***@qirtas.test`. Domain kept: it is what tells support "this is a work address". */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** `0933111222` → `*******222`. The tail is enough to tell two customers apart on a call. */
export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const tail = phone.slice(-3);
  return `${'*'.repeat(Math.max(phone.length - 3, 0))}${tail}`;
}

/** Applies the policy to one wire row. Identity for holders of `customers.contact`. */
export function applyContactPolicy(wire: WireCustomer, canSeeContact: boolean): WireCustomer {
  if (canSeeContact) return wire;
  return { ...wire, email: maskEmail(wire.email), phone: maskPhone(wire.phone) };
}
