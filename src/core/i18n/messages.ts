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
  // A customer reached a purchase-tier route with an unproven address. The
  // client keys on this to open the code screen, so it must stay distinct from
  // any generic 403.
  email_verification_required: {
    en: 'Confirm your email address to continue',
    ar: 'أكِّد بريدك الإلكتروني للمتابعة',
  },
  verification_already_verified: {
    en: 'This email address is already confirmed',
    ar: 'هذا البريد الإلكتروني مؤكَّد بالفعل',
  },
  wholesale_request_not_allowed: {
    en: 'A wholesale request is already open or approved for this account',
    ar: 'يوجد طلب جملة مفتوح أو معتمد لهذا الحساب',
  },
  wholesale_not_pending: {
    en: 'This account has no pending wholesale request',
    ar: 'لا يوجد طلب جملة قيد المراجعة لهذا الحساب',
  },
  customer_archived: {
    en: 'This customer is archived. Restore it before changing it.',
    ar: 'هذا الزبون مؤرشف. أعد تفعيله قبل التعديل.',
  },
  customer_delete_requires_disabled: {
    en: 'Only a disabled customer can be deleted',
    ar: 'لا يُحذف إلا حساب زبون معطَّل',
  },
  customer_not_archived: {
    en: 'This customer is not archived',
    ar: 'هذا الزبون غير مؤرشف',
  },
  verification_resend_cooldown: {
    en: 'A code was just sent — please wait before requesting another',
    ar: 'أُرسل رمز للتوّ — انتظر قليلاً قبل طلب رمز جديد',
  },
  verification_disabled: {
    en: 'Email verification is not enabled on this server',
    ar: 'تأكيد البريد الإلكتروني غير مفعَّل على هذا الخادم',
  },
  /**
   * The code was issued but the mail server refused the message.
   *
   * Says "just now" and "try again" because from the user's side that is the
   * whole truth and the whole remedy — whether the cause was credentials, a
   * sender-domain policy or a dead socket is an operator's problem, and naming
   * it here would describe our infrastructure to whoever asked. The real reason
   * is in the server log and the audit row.
   */
  verification_send_failed: {
    en: 'We could not send the verification email just now — please try again shortly',
    ar: 'تعذّر إرسال رسالة التأكيد الآن — حاول مرة أخرى بعد قليل',
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
  // A WARNING, not a wall: staffing is the admin's call, and "this post must
  // always be filled" is not a rule the system gets to invent. Pass `force` to
  // proceed. Distinguished from `last_system_role_holder` below by key, because
  // only one of the two is overridable and both are 409.
  last_qualified_staff: {
    en: 'This is the last active staff member holding this role in this branch. End the assignment anyway, or assign the role to someone else first.',
    ar: 'هذا آخر موظف فعّال يحمل هذا الدور في هذا الفرع. يمكنك إنهاء التعيين على أي حال، أو إسناد الدور لموظف آخر أولاً.',
  },
  // Same rule, different caller: suspending/disabling closes EVERY post at
  // once, so it has no `force` and must not borrow wording that offers one.
  user_release_last_qualified_staff: {
    en: 'This person is the last active holder of a role in an operating branch. End or transfer that assignment first, then take the account out of service.',
    ar: 'هذا الشخص آخر من يشغل دوراً في فرع عامل. أنهِ ذلك التعيين أو انقله أولاً، ثم أوقف الحساب.',
  },
  // The one refusal `force` does not open, because the state it prevents cannot
  // be undone from inside the app: nobody left who can manage users means
  // nobody left who can hand the permission back.
  last_system_role_holder: {
    en: 'This is the last active person who can manage users. Releasing them would leave nobody able to administer the system — assign the role to someone else first.',
    ar: 'هذا آخر شخص فعّال يستطيع إدارة المستخدمين. إنهاء تعيينه يترك النظام بلا من يديره — أسنِد الدور لموظف آخر أولاً.',
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
  /**
   * The one refusal in the overrides screen that protects the administrator
   * from themselves: denying yourself the permission that opens this screen
   * leaves nobody able to undo it.
   */
  authz_self_lockout: {
    en: 'You cannot deny yourself a permission you need to manage access',
    ar: 'لا يمكنك حظر صلاحية عن نفسك تحتاجها لإدارة الصلاحيات',
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

  // ── Removal: delete (no history) vs archive (has history) ──────────────────
  //
  // Every refusal below names the OTHER exit, because that is the reader's
  // actual next move. "Cannot be deleted" leaves an admin re-checking a staff
  // list that was never the obstacle; "it has a past — archive it instead"
  // ends the task. See docs/rest_api.md §16.

  branch_is_default: {
    en: 'The default branch cannot be removed — make another branch the default first',
    ar: 'الفرع الافتراضي لا يُحذف ولا يُؤرشف — اجعل فرعاً آخر الافتراضي أولاً',
  },
  branch_has_history: {
    en: 'This branch appears in the assignment history. Archive it instead — deleting would erase where those people worked.',
    ar: 'هذا الفرع موجود بسجل التعيينات. أرشفه بدل حذفه — الحذف يمحو المكان الذي عمل فيه أولئك الأشخاص.',
  },
  branch_has_active_ownerships: {
    en: 'This branch still has active ownership records. End them before archiving it.',
    ar: 'لا يزال لهذا الفرع سجلات ملكية فعّالة. أنهِها قبل أرشفته.',
  },
  branch_name_taken: {
    en: 'This branch name is already in use',
    ar: 'اسم الفرع هذا مستخدم بالفعل',
  },
  // A separate key from the one above, not a nicety: the two lead to different
  // actions. A live clash means pick another name; an archived clash means the
  // branch being recreated already exists and can come back with its history
  // rather than start over as an empty duplicate the reader cannot see.
  branch_name_taken_by_archived: {
    en: 'An archived branch already uses this name — restore it instead, or choose another name',
    ar: 'يوجد فرع مؤرشف بهذا الاسم — استرجعه بدل إنشاء فرع جديد، أو اختر اسماً آخر',
  },
  branch_archived: {
    en: 'This branch is archived. Restore it before editing.',
    ar: 'هذا الفرع مؤرشف. استرجعه قبل تعديله.',
  },

  role_system_default_unarchivable: {
    en: 'A system-default role cannot be archived — re-seeding keeps it in the catalogue',
    ar: 'الدور الافتراضي بالنظام لا يُؤرشف — إعادة الزرع تُبقيه بالكتالوج',
  },
  role_has_active_holders: {
    en: 'This role is still held. End or transfer those assignments before archiving it.',
    ar: 'ما زال هذا الدور محمولاً. أنهِ تلك التعيينات أو انقلها قبل أرشفته.',
  },
  role_archived: {
    en: 'This role is archived. Restore it before editing.',
    ar: 'هذا الدور مؤرشف. استرجعه قبل تعديله.',
  },

  user_cannot_remove_self: {
    en: 'You cannot remove your own account',
    ar: 'لا يمكنك حذف أو أرشفة حسابك أنت',
  },
  user_has_audit_history: {
    en: 'This account has activity recorded in the audit log and cannot be deleted. Archive it instead.',
    ar: 'لهذا الحساب نشاط مسجَّل بسجل التدقيق فلا يمكن حذفه. أرشفه بدلاً من ذلك.',
  },
  user_has_history: {
    en: 'This account appears in the assignment history. Archive it instead — deleting would erase where this person worked.',
    ar: 'هذا الحساب موجود بسجل التعيينات. أرشفه بدل حذفه — الحذف يمحو المكان الذي عمل فيه هذا الشخص.',
  },
  user_has_active_assignments: {
    en: 'This person still holds active assignments. End or transfer them before archiving the account.',
    ar: 'ما زال هذا الشخص يحمل تعيينات فعّالة. أنهِها أو انقلها قبل أرشفة الحساب.',
  },
  user_has_active_ownerships: {
    en: 'This person still holds active ownership records. End them before archiving the account.',
    ar: 'ما زال لهذا الشخص سجلات ملكية فعّالة. أنهِها قبل أرشفة الحساب.',
  },
  user_archived: {
    en: 'This account is archived. Restore it before editing.',
    ar: 'هذا الحساب مؤرشف. استرجعه قبل تعديله.',
  },
  email_taken: {
    en: 'An account with this email already exists',
    ar: 'يوجد حساب بهذا البريد الإلكتروني بالفعل',
  },
  registration_not_rejected: {
    en: 'Only a rejected registration can be resubmitted',
    ar: 'إعادة الإرسال متاحة للطلب المرفوض وحده',
  },
  role_not_self_registerable: {
    en: 'This role cannot be requested at registration — an administrator grants it directly',
    ar: 'هذا الدور لا يُطلب عند التسجيل — يمنحه الأدمن مباشرة',
  },
  branch_not_self_registerable: {
    en: 'This branch cannot be requested at registration — it is closed or archived',
    ar: 'هذا الفرع لا يُطلب عند التسجيل — مغلق نهائياً أو مؤرشف',
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
  /**
   * The staging token behind a two-phase import is gone: spent, or older than
   * its fifteen minutes. Both wordings name the way out — re-upload — because
   * the token is consumed before the write, so pressing the same button again
   * can never succeed.
   */
  import_token_gone: {
    en: 'This import is no longer valid — it was already used or has expired. Upload the file again.',
    ar: 'هذه العملية لم تعد صالحة — استُخدمت أو انتهت مهلتها. أعد رفع الملف.',
  },
  /**
   * The resource exists but declares no `import` block. The client hides the
   * screen from its own descriptor, so this is reached by a stale build or a
   * hand-made request — and the reader is still an admin, not a developer.
   */
  transfer_import_unsupported: {
    en: 'This data type cannot be imported',
    ar: 'هذا النوع من البيانات لا يقبل الاستيراد',
  },
  /** A row lost the race to the unique index between review and write. */
  import_conflict: {
    en: 'Some rows collide with records that already exist. Nothing was imported — upload the file again to see which rows.',
    ar: 'بعض الصفوف تتعارض مع سجلات موجودة. لم يُستورد شيء — أعد رفع الملف لتظهر الصفوف المتعارضة.',
  },
  /**
   * `express.json()` refused the body — malformed JSON, wrong charset, or the
   * client hung up mid-upload. Set by `error-handler.ts`, not by any throw
   * site, which is why `check:messages` cannot see its use.
   *
   * Worded as "try again" because that is genuinely the fix: the most common
   * cause here is a truncated request on a flaky mobile connection, not a
   * malformed client.
   */
  body_malformed: {
    en: 'The request could not be read — please try again',
    ar: 'تعذّرت قراءة الطلب — يرجى المحاولة مرة أخرى',
  },
  body_too_large: {
    en: 'The request is too large',
    ar: 'حجم الطلب كبير جداً',
  },
} as const satisfies Record<string, Record<Lang, string>>;

export type MessageKey = keyof typeof MESSAGES;

/** Looks up `key` for `lang`; falls back to `fallback` (the ApiError's own English message) if the key is unknown. */
export function resolveMessage(key: string | undefined, lang: Lang, fallback: string): string {
  if (!key) return fallback;
  const entry = (MESSAGES as Record<string, Record<Lang, string> | undefined>)[key];
  return entry?.[lang] ?? fallback;
}
