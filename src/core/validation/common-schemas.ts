import { z } from 'zod';

/**
 * Syrian mobile number: exactly 10 digits, starting with "09" (e.g.
 * 0933111222). This is a hard project-wide rule — every phone/contact_info
 * field accepting a phone number MUST use this schema, never a bare
 * `z.string()` with only a length cap. That gap is exactly how a value like
 * "تر" was previously accepted as a branch's contact_info (see
 * qirtas_backend/src/core/CLAUDE.md §Validation).
 */
const SYRIAN_PHONE_REGEX = /^09\d{8}$/;

export const syrianPhoneSchema = z
  .string()
  .trim()
  .regex(SYRIAN_PHONE_REGEX, 'Phone number must be 10 digits starting with 09 (e.g. 0933111222)');

/** Optional variant — for fields like `contact_info` that may be omitted entirely. */
export const optionalSyrianPhoneSchema = syrianPhoneSchema.optional();

/** Nullable+optional variant — for PATCH bodies that allow explicit `null` to clear the field. */
export const nullableSyrianPhoneSchema = syrianPhoneSchema.nullable().optional();

/**
 * A boolean carried in a query string. **Use this, never `z.coerce.boolean()`.**
 *
 * `z.coerce.boolean()` applies JavaScript's `Boolean()`, and every non-empty
 * string is truthy — so `?is_active=false` parses to `true`. The filter does not
 * fail, does not warn, and returns the exact opposite of what was asked for:
 * `GET /roles?is_active=false` listed every ACTIVE role (verified live,
 * 2026-08-05, before this schema existed). The same trap sat on `assignable`,
 * `unassigned`, `is_admin`, and `is_default`.
 *
 * This accepts the two spellings a client actually sends and rejects everything
 * else with a 422 — a typo'd `?unassigned=yes` should be a visible error, not a
 * silent `true`.
 */
export const queryBooleanSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');
