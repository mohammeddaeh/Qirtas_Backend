import { z } from 'zod';
import { authConfig } from '../config/auth-config.js';
import { hashPassword, verifyPassword } from '../../security/password.js';

/**
 * The password policy, as one schema every entry point shares.
 *
 * ## Why this exists when `core/security/password.ts` already did
 *
 * That file hashes and verifies — it says nothing about what a password is
 * *allowed to be*. The rule lived instead as a `passwordSchema` constant inside
 * `features/identity/dtos/users.dto.ts`, which meant the policy was owned by
 * one feature's DTO file while being enforced on registration, admin creation,
 * bootstrap, reset and change. A second feature needing a password would have
 * either imported another feature's DTO (forbidden) or copied the regexes.
 *
 * Hashing stays where it is and is re-exported below, so nothing that already
 * imports it has to move.
 *
 * ## Why the rules are what they are
 *
 * Length does the work; character classes mostly do not. Requiring symbols and
 * mixed case is how `P@ssw0rd!` became the most common "strong" password in
 * every breach corpus — the rule shapes the guess space it was meant to widen.
 * So the policy refuses the genuinely trivial (too short, no letter, no digit)
 * and leaves the rest to length, which is configurable per deployment.
 *
 * The upper bound is not a strength rule: it bounds the work an attacker can
 * make the server do, since the KDF's cost scales with input.
 */

export function buildPasswordSchema(): z.ZodString {
  let schema = z
    .string()
    .min(
      authConfig.password.minLength,
      `Password must be at least ${authConfig.password.minLength} characters`,
    )
    .max(authConfig.password.maxLength);

  if (authConfig.password.requireLetter) {
    schema = schema.regex(/[A-Za-z]/, 'Password must contain at least one letter');
  }
  if (authConfig.password.requireDigit) {
    schema = schema.regex(/\d/, 'Password must contain at least one digit');
  }
  return schema;
}

/**
 * The single schema every "set a password" input uses.
 *
 * Built once at module load: the policy comes from validated environment and
 * cannot change while the process runs, so rebuilding it per request would only
 * cost allocations.
 */
export const passwordSchema = buildPasswordSchema();

/**
 * The schema for a password being **checked** rather than **set**.
 *
 * Deliberately just "non-empty". Validating a current password against today's
 * strength rules would lock out every account whose real password predates
 * them: the user cannot supply a value that satisfies a policy their own
 * password does not meet, and their only escape would be the reset flow. The
 * rule applies at the moment a password is chosen, not forever afterwards.
 */
export const existingPasswordSchema = z.string().min(1);

// Re-exported so callers have one import for everything password-related, and
// so `core/security/password.ts` stays the only place the KDF is chosen.
export { hashPassword, verifyPassword };
