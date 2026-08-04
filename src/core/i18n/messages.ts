/**
 * Tiny message dictionary for user-facing error strings that must respect
 * `req.lang` (see src/core/middleware/request-context.ts).
 *
 * This is intentionally NOT a general i18n library (no i18next dependency —
 * none exists in package.json and this app doesn't need one yet). It's a
 * flat key → {ar, en} map consulted only by error-handler.ts, for the small
 * set of errors a real end user actually reads (mainly /login failures).
 *
 * Scope: services/controllers keep throwing ApiError as before. A service
 * that wants a translated message additionally passes `messageKey` (see
 * ApiError in http/api-error.ts) — the English `message` argument stays as
 * the fallback for any lang not covered here and for logs/Swagger examples.
 *
 * Add a key here only when a throw site sets `messageKey` to it — an unused
 * key is dead weight, and a `messageKey` with no entry here just falls back
 * to the ApiError's own `message` (see resolveErrorMessage below).
 */

/**
 * Single source of truth for supported languages. Adding a language is:
 *   1. add its code here,
 *   2. fix the resulting TypeScript errors below (every MESSAGES key must
 *      cover it — `satisfies Record<string, Record<Lang, string>>` enforces
 *      this at compile time, so a missing translation cannot ship silently).
 * `request-context.ts` derives `req.lang`'s validation from this list —
 * no separate language list to keep in sync there.
 */
export const SUPPORTED_LANGUAGES = ['ar', 'en'] as const;
export type Lang = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANG: Lang = 'ar';

export function isSupportedLang(value: string | undefined): value is Lang {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value ?? '');
}

export const MESSAGES = {
  invalid_credentials: {
    en: 'Invalid email or password',
    ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
  },
  account_pending_approval: {
    en: 'Your registration is still pending admin approval',
    ar: 'طلب تسجيلك لا يزال قيد مراجعة الإدارة',
  },
  account_suspended: {
    en: 'Your account is temporarily suspended',
    ar: 'تم إيقاف حسابك مؤقتاً',
  },
  account_disabled: {
    en: 'Your account has been disabled',
    ar: 'تم تعطيل حسابك',
  },

  // --- Assignment & role guards -------------------------------------------
  // These are read by an admin mid-task (staffing a branch, moving someone),
  // not by a developer, so they must follow the device language like any
  // other user-facing string.
  last_qualified_staff: {
    en: 'This is the last active staff member holding this role in this branch. Assign a qualified replacement before transferring or removing them.',
    ar: 'هذا آخر موظف فعّال يحمل هذا الدور في هذا الفرع. عيّن بديلاً مؤهلاً قبل نقله أو إنهاء تعيينه.',
  },
  role_above_actor_level: {
    en: 'Cannot assign a role at or above your own authority level',
    ar: 'لا يمكنك إسناد دور بمستوى صلاحية مساوٍ لمستواك أو أعلى منه',
  },
  // --- Rate limits ---------------------------------------------------------
  too_many_login_attempts: {
    en: 'Too many login attempts — please try again later',
    ar: 'محاولات دخول كثيرة — حاول مرة أخرى لاحقاً',
  },
  too_many_register_attempts: {
    en: 'Too many registration attempts — please try again later',
    ar: 'محاولات تسجيل كثيرة — حاول مرة أخرى لاحقاً',
  },

  assignment_duplicate: {
    en: 'This person already holds that role in that branch.',
    ar: 'هذا الشخص يحمل هذا الدور في هذا الفرع أصلاً.',
  },
  branch_has_active_assignments: {
    en: 'This branch still has active role assignments. Transfer or end them before closing it permanently.',
    ar: 'لا يزال هذا الفرع يحتوي تعيينات فعّالة. انقلها أو أنهِها قبل إغلاقه نهائياً.',
  },
  role_name_taken: {
    en: 'This role name is already in use',
    ar: 'اسم الدور هذا مستخدَم بالفعل',
  },
  role_duplicate_permission_set: {
    en: 'An active role already has this exact permission set.',
    ar: 'يوجد دور فعّال يحمل نفس مجموعة الصلاحيات بالضبط.',
  },
  role_edit_above_actor_level: {
    en: 'Cannot create or modify a role at or above your own authority level',
    ar: 'لا يمكنك إنشاء أو تعديل دور بمستوى صلاحية مساوٍ لمستواك أو أعلى منه',
  },
} as const satisfies Record<string, Record<Lang, string>>;

export type MessageKey = keyof typeof MESSAGES;

/** Looks up `key` for `lang`; falls back to `fallback` (the ApiError's own English message) if the key is unknown. */
export function resolveMessage(key: string | undefined, lang: Lang, fallback: string): string {
  if (!key) return fallback;
  const entry = (MESSAGES as Record<string, Record<Lang, string> | undefined>)[key];
  return entry?.[lang] ?? fallback;
}
