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
