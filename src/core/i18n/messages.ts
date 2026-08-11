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
  account_rejected: {
    en: 'Your registration request was declined',
    ar: 'تم رفض طلب تسجيلك',
  },
  /**
   * The address has not been proven yet. Distinct from every other refusal
   * because it is the only one the user can clear themselves — the client shows
   * the code screen instead of "contact your administrator".
   */
  account_email_unverified: {
    en: 'Confirm your email address to continue',
    ar: 'أكّد بريدك الإلكتروني للمتابعة',
  },

  // --- Sessions ------------------------------------------------------------
  session_expired: {
    en: 'Your session has expired — please sign in again',
    ar: 'انتهت صلاحية جلستك — سجّل الدخول من جديد',
  },
  session_not_found: {
    en: 'This session no longer exists',
    ar: 'هذه الجلسة لم تعد موجودة',
  },

  // --- Email verification --------------------------------------------------
  // One message for wrong / expired / already-used / out-of-attempts, on
  // purpose: telling them apart would let someone probe which accounts have a
  // verification in flight, and all four mean the same thing to a real user —
  // ask for a new code.
  verification_code_invalid: {
    en: 'This verification code is invalid or has expired',
    ar: 'رمز التأكيد غير صالح أو انتهت صلاحيته',
  },
  verification_already_verified: {
    en: 'This email address is already confirmed',
    ar: 'هذا البريد الإلكتروني مؤكَّد بالفعل',
  },
  verification_resend_cooldown: {
    en: 'A code was just sent — please wait before requesting another',
    ar: 'أُرسل رمز للتوّ — انتظر قليلاً قبل طلب رمز جديد',
  },
  verification_disabled: {
    en: 'Email verification is not enabled on this server',
    ar: 'تأكيد البريد الإلكتروني غير مفعَّل على هذا الخادم',
  },
  auth_provider_missing: {
    en: 'Sign-in is not configured on this server',
    ar: 'تسجيل الدخول غير مُهيّأ على هذا الخادم',
  },
  /**
   * Fallback when an [AccountStore] refuses a sign-in without naming a reason.
   *
   * Qirtas's own store always names one (`account_suspended`,
   * `account_disabled`), so this should never be reached here. It exists
   * because `reasonKey` is optional in the port, and an application that omits
   * it must still get a translated refusal rather than the English fallback —
   * a hole the message-key check caught before it shipped.
   */
  sign_in_not_permitted: {
    en: 'Sign-in is not permitted for this account',
    ar: 'تسجيل الدخول غير متاح لهذا الحساب',
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
  too_many_reset_attempts: {
    en: 'Too many password reset attempts — please try again later',
    ar: 'محاولات استعادة كثيرة — حاول مرة أخرى لاحقاً',
  },
  too_many_verification_attempts: {
    en: 'Too many verification attempts — please try again later',
    ar: 'محاولات تأكيد كثيرة — حاول مرة أخرى لاحقاً',
  },

  // --- Password reset & change ---------------------------------------------
  // One message covers wrong / expired / already-used / unknown-address on
  // purpose: telling them apart would let someone probe which addresses have a
  // reset in flight, and all four mean the same thing to a real user — ask for
  // a new code.
  reset_code_invalid: {
    en: 'This reset code is invalid or has expired',
    ar: 'رمز الاستعادة غير صالح أو انتهت صلاحيته',
  },
  current_password_wrong: {
    en: 'Your current password is incorrect',
    ar: 'كلمة المرور الحالية غير صحيحة',
  },
  password_must_differ: {
    en: 'The new password must differ from the current one',
    ar: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية',
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
  role_has_history: {
    en: 'This role appears in the assignment history. Deactivate it instead — deleting would erase what those people once were.',
    ar: 'هذا الدور موجود بسجل التعيينات. عطّله بدل حذفه — الحذف يمحو ما كان عليه أولئك الأشخاص.',
  },
  role_system_default_undeletable: {
    en: 'A system-default role cannot be deleted — re-seeding would recreate it',
    ar: 'الدور الافتراضي بالنظام لا يُحذف — إعادة الزرع تُنشئه من جديد',
  },
  role_already_active: {
    en: 'This role is already active',
    ar: 'هذا الدور فعّال بالفعل',
  },
  permission_key_taken: {
    en: 'This permission key already exists in the catalogue',
    ar: 'مفتاح الصلاحية هذا موجود بالكتالوج بالفعل',
  },
  permission_module_display_required: {
    en: 'This is a new module — provide its display name in Arabic and English so its permission group has a title',
    ar: 'هذه وحدة جديدة — أدخل اسمها بالعربية والإنجليزية ليحمل صف صلاحياتها عنواناً',
  },
  super_admin_role_immutable: {
    en: 'The Super Admin role cannot be renamed — core authority checks identify it by name',
    ar: 'لا يمكن إعادة تسمية دور المدير العام — فحوص الصلاحية الأساسية تُعرِّفه باسمه',
  },
  authentication_required: {
    en: 'Authentication required',
    ar: 'يلزم تسجيل الدخول',
  },
  permission_missing: {
    en: 'You do not have the permission required for this action',
    ar: 'لا تملك الصلاحية اللازمة لهذا الإجراء',
  },
  ownership_sum_exceeded: {
    en: 'Ownership percentages for this scope would exceed 100%',
    ar: 'مجموع نسب الملكية لهذا النطاق سيتجاوز ١٠٠٪',
  },
  permission_key_unknown: {
    en: 'One or more permission keys do not exist in the catalogue',
    ar: 'مفتاح صلاحية أو أكثر غير موجود بالكتالوج',
  },
  language_not_seeded: {
    en: 'A bundled language row is missing — run the seed script',
    ar: 'صف لغة أساسية مفقود — شغّل سكربت الزرع',
  },
  role_level_super_admin_only: {
    en: "Only the Super Admin can change a role's authority level",
    ar: 'تعديل مستوى سلطة الدور متاح للمدير العام حصراً',
  },
  super_admin_role_undeactivatable: {
    en: 'The Super Admin role can never be deactivated',
    ar: 'دور المدير العام لا يُعطَّل أبداً',
  },
  role_has_active_assignments: {
    en: 'This role is still held by active staff. Move or end their assignments first — you can do that from the holders list below.',
    ar: 'ما زال هذا الدور محمولاً من موظفين فعّالين. انقل تعييناتهم أو أنهِها أولاً — تستطيع ذلك من قائمة الحاملين أسفل الشاشة.',
  },
  user_root_protected: {
    en: 'This account is protected and cannot be modified',
    ar: 'هذا الحساب محميّ ولا يمكن تعديله',
  },
  email_taken: {
    en: 'An account with this email already exists',
    ar: 'يوجد حساب بهذا البريد الإلكتروني بالفعل',
  },
  registration_not_rejected: {
    en: 'Only a rejected registration can be resubmitted',
    ar: 'إعادة الإرسال متاحة للطلب المرفوض وحده',
  },
  role_inactive_unassignable: {
    en: 'An inactive role cannot be assigned',
    ar: 'لا يمكن إسناد دور معطَّل',
  },
  registration_not_pending: {
    en: 'This account is not awaiting approval',
    ar: 'هذا الحساب ليس بانتظار الموافقة',
  },
  registration_role_required: {
    en: 'A role must be chosen to approve this registration',
    ar: 'يجب اختيار دور للموافقة على هذا الطلب',
  },
  setup_already_completed: {
    en: 'Setup has already been completed — bootstrap is only available on a fresh install',
    ar: 'الإعداد الأولي تمّ سابقاً — التهيئة متاحة على تثبيت جديد فقط',
  },
  super_admin_role_not_seeded: {
    en: 'The Super Admin role is not seeded — run the seed script first',
    ar: 'دور المدير العام غير مزروع — شغّل سكربت الزرع أولاً',
  },
  user_status_not_reactivatable: {
    en: 'An account with this status cannot be reactivated',
    ar: 'لا يمكن إعادة تفعيل حساب بهذه الحالة',
  },
  language_code_taken: {
    en: 'A language with this code already exists',
    ar: 'يوجد لغة بهذا الرمز بالفعل',
  },
} as const satisfies Record<string, Record<Lang, string>>;

export type MessageKey = keyof typeof MESSAGES;

/** Looks up `key` for `lang`; falls back to `fallback` (the ApiError's own English message) if the key is unknown. */
export function resolveMessage(key: string | undefined, lang: Lang, fallback: string): string {
  if (!key) return fallback;
  const entry = (MESSAGES as Record<string, Record<Lang, string> | undefined>)[key];
  return entry?.[lang] ?? fallback;
}
