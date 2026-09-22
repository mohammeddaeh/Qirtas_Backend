import { z } from 'zod';
import {
  passwordSchema,
  existingPasswordSchema,
} from '../../../core/auth/services/password.service.js';
import type { SessionRow } from '../../../core/auth/schemas/sessions.schema.js';

/**
 * Request and response shapes for the authentication endpoints.
 *
 * `passwordSchema` is imported, never redefined. It used to live in
 * `features/identity/dtos/users.dto.ts`, which meant the password policy was
 * owned by one feature's DTO file while five endpoints enforced it — and a
 * second feature needing a password would have had to import another feature's
 * DTOs (forbidden) or restate the rules (guaranteed to drift). It now lives in
 * `core/auth/services/password.service.ts` and both features import it.
 */

const emailSchema = z.string().trim().toLowerCase().email().max(255);

/**
 * A short, human-typed code — six digits.
 *
 * Whitespace and case are normalised here rather than rejected: copying out of a
 * mail client brings spaces, six digits are commonly typed in groups, and a
 * lower-case entry of a pre-change letter code is that code typed correctly.
 * Refusing any of them would be refusing a correct answer on a formatting
 * technicality.
 *
 * The length bounds stay wide deliberately. This schema screens out obvious
 * junk; the real check is the hash comparison in verification.service.ts.
 * Narrowing it to exactly six would reject the letter codes still inside their
 * fifteen-minute life at the moment the format changed — a self-inflicted
 * outage for the few users mid-flow, in exchange for nothing.
 */
const codeSchema = z
  .string()
  .trim()
  .min(4)
  .max(64)
  .transform((v) => v.replace(/\s+/g, '').toUpperCase());

export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
  /** Free-text device label shown on the "my devices" screen — never trusted for any decision. */
  device_info: z.string().trim().max(500).optional(),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const verifyEmailBodySchema = z.object({
  code: codeSchema,
});
export type VerifyEmailBody = z.infer<typeof verifyEmailBodySchema>;

export const forgotPasswordBodySchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBodySchema>;

/**
 * `email` travels again on this step because the code commonly arrives on a
 * different device from the one that asked for it — which is the normal case
 * when it arrives by email.
 */
export const resetPasswordBodySchema = z
  .object({
    email: emailSchema,
    code: codeSchema.optional(),
    /**
     * The previous spelling of `code`, accepted for compatibility.
     *
     * It was never a token: it is eight characters a person reads off a screen
     * and retypes, and naming it `token` invited clients to treat it as opaque
     * and arbitrarily long. Renamed with the move to `features/auth`; the old
     * key still works so the already-shipped mobile client keeps functioning
     * across the deploy. Remove once no released client sends it.
     */
    token: codeSchema.optional(),
    new_password: passwordSchema,
  })
  // Refined rather than made a union: exactly one of the two must be present,
  // and a body carrying neither must fail validation loudly instead of reaching
  // the service with an undefined code — where it would be indistinguishable
  // from a wrong one and answer 422 with the wrong reason.
  .refine((b) => b.code !== undefined || b.token !== undefined, {
    message: 'A reset code is required',
    path: ['code'],
  })
  .transform((b) => ({
    email: b.email,
    code: (b.code ?? b.token) as string,
    new_password: b.new_password,
  }));
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;

export const changePasswordBodySchema = z.object({
  /**
   * Validated as "non-empty", never against the strength policy.
   *
   * This value is being *checked*, not *set*. Applying today's rules to it
   * would lock out every account whose real password predates them — the user
   * cannot supply something that satisfies a policy their own password does
   * not meet, and their only way out would be the reset flow.
   */
  current_password: existingPasswordSchema,
  new_password: passwordSchema,
  /**
   * Whether to end this account's other sessions.
   *
   * Defaults to false: the user is present and chose to change their password,
   * so signing their other devices out unasked is a surprise rather than a
   * protection. Offered as a choice because only they know whether the change
   * was routine or a response to something.
   */
  revoke_other_sessions: z.boolean().optional().default(false),
});
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;

export const sessionIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** A session as the owner sees it. The token is absent by construction — it exists only as a digest and only the holder ever had it. */
export interface WireSession {
  id: number;
  device_info: string | null;
  provider: string;
  created_at: string;
  last_active_at: string;
  expires_at: string;
  /** Whether this row is the session making the request — the client marks it "this device" and refuses to offer "sign out" on it. */
  is_current: boolean;
}

export function toWireSession(row: SessionRow, currentSessionId: number | null): WireSession {
  return {
    id: row.id,
    device_info: row.device_info,
    provider: row.provider,
    created_at: row.created_at.toISOString(),
    last_active_at: row.last_active_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    is_current: row.id === currentSessionId,
  };
}

/** Mirrors WireSession for OpenAPI generation only — zod-to-openapi needs a schema, not a TS interface. Keep both in sync. */
export const sessionResponseSchema = z.object({
  id: z.number().int(),
  device_info: z.string().nullable(),
  provider: z.string(),
  created_at: z.string(),
  last_active_at: z.string(),
  expires_at: z.string(),
  is_current: z.boolean(),
});

export const refreshResponseSchema = z.object({
  token: z.string(),
  /** False when the presented token was still young enough to keep — the client stores what it is given either way. */
  rotated: z.boolean(),
  expires_at: z.string(),
});

export const mfaCodeBodySchema = z.object({
  code: z.string().trim().min(6).max(16),
});
export type MfaCodeBody = z.infer<typeof mfaCodeBodySchema>;

/** Disabling needs the password AND a code: a stolen session alone must not be able to drop the factor. */
export const mfaDisableBodySchema = z.object({
  password: z.string().min(1),
  code: z.string().trim().min(6).max(16),
});
export type MfaDisableBody = z.infer<typeof mfaDisableBodySchema>;

/** A device announcing where pushes for the signed-in account should go. */
export const registerPushTokenBodySchema = z.object({
  token: z.string().trim().min(20).max(512),
  platform: z.enum(['android', 'ios']),
  /** The app language on this device — the push is written in it. */
  language: z.string().trim().max(8).optional(),
});
export type RegisterPushTokenBody = z.infer<typeof registerPushTokenBodySchema>;

export const removePushTokenBodySchema = z.object({
  token: z.string().trim().min(20).max(512),
});
export type RemovePushTokenBody = z.infer<typeof removePushTokenBodySchema>;
