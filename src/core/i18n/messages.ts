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
  session_revoked: {
    en: 'You were signed out of this device',
    ar: 'تم تسجيل خروجك من هذا الجهاز',
  },
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
  wholesale_not_approved: {
    en: 'This account is not an approved wholesale account',
    ar: 'هذا الحساب ليس حساب جملة معتمداً',
  },
  mfa_already_enrolled: {
    en: 'Two-factor authentication is already set up',
    ar: 'المصادقة الثنائية مفعّلة بالفعل',
  },
  mfa_not_started: {
    en: 'Start the setup first',
    ar: 'ابدأ الإعداد أولاً',
  },
  mfa_code_invalid: {
    en: 'The code is wrong or expired',
    ar: 'الرمز خاطئ أو منتهي',
  },
  mfa_locked: {
    en: 'Too many wrong codes. Try again in 15 minutes.',
    ar: 'محاولات خاطئة كثيرة. أعد المحاولة بعد ١٥ دقيقة.',
  },
  mfa_challenge_invalid: {
    en: 'The sign-in step expired. Sign in again.',
    ar: 'انتهت خطوة الدخول. سجّل الدخول من جديد.',
  },
  mfa_staff_only: {
    en: 'Two-factor authentication is for staff accounts',
    ar: 'المصادقة الثنائية لحسابات الموظفين',
  },
  mfa_required_by_role: {
    en: 'Your role requires two-factor authentication',
    ar: 'منصبك يتطلّب المصادقة الثنائية',
  },
  mfa_setup_required: {
    en: 'Set up two-factor authentication to continue',
    ar: 'فعّل المصادقة الثنائية للمتابعة',
  },
  mfa_reset_self_forbidden: {
    en: 'You cannot reset your own two-factor authentication',
    ar: 'لا يمكنك إعادة ضبط المصادقة الثنائية لحسابك',
  },
  email_change_not_allowed: {
    en: 'A verified email address cannot be changed here. Contact support.',
    ar: 'لا يمكن تغيير بريد موثَّق من هنا. تواصل مع الدعم.',
  },
  email_unchanged: {
    en: 'That is already your email address',
    ar: 'هذا هو بريدك الحالي بالفعل',
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
  address_limit_reached: {
    en: 'You have reached the maximum number of saved addresses. Remove one to add another.',
    ar: 'وصلت للحد الأقصى من العناوين المحفوظة. احذف عنواناً لتضيف غيره.',
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
  role_key_not_held: {
    en: 'You cannot give a role a permission you do not hold yourself',
    ar: 'لا يمكنك إضافة صلاحية لدور وأنت لا تملكها',
  },
  mfa_not_enabled: {
    en: 'Two-factor authentication is not available yet',
    ar: 'المصادقة الثنائية غير متاحة بعد',
  },
  account_not_approved: {
    en: 'This account has not been approved yet',
    ar: 'لم تتم الموافقة على هذا الحساب بعد',
  },
  override_key_not_held: {
    en: 'You cannot grant a permission you do not hold yourself',
    ar: 'لا يمكنك منح صلاحية لا تملكها أنت',
  },
  override_target_outranks_actor: {
    en: 'You cannot change the permissions of an account at or above your own authority level',
    ar: 'لا يمكنك تعديل صلاحيات حساب بمستوى سلطة مساوٍ لمستواك أو أعلى منه',
  },
  override_target_not_active: {
    en: 'Permissions can only be granted to an active account',
    ar: 'لا تُمنح الصلاحيات إلا لحساب نشط',
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
  // One email, one account, across both realms (`account_emails`). There is no
  // customer-to-staff conversion, so the way out is a second email — say so.
  // Deliberately silent on *which* realm holds it: naming it would tell anyone
  // typing addresses into the sign-up form which ones belong to staff.
  email_taken: {
    en: 'This email already belongs to another account. Use a different email — a work account and a shopping account cannot share one.',
    ar: 'هذا البريد مستخدَم لحساب آخر. استعمل بريداً مختلفاً — حساب العمل وحساب التسوّق لا يشتركان ببريد واحد.',
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

  // ── Files and images (core/media/) ────────────────────────────────────────
  // Read by whoever is filling a catalog form — each names what to do next.
  image_too_large: {
    en: 'The image is larger than 10 MB — choose a smaller one',
    ar: 'حجم الصورة أكبر من ١٠ ميغابايت — اختر صورة أصغر',
  },
  image_unsupported_format: {
    en: 'Only JPEG, PNG or WebP images are accepted',
    ar: 'تُقبل صور JPEG أو PNG أو WebP فقط',
  },
  image_too_small: {
    en: 'The image is too small — its shortest side must be at least 200 pixels',
    ar: 'الصورة صغيرة جداً — يجب ألا يقل أقصر أضلاعها عن ٢٠٠ بكسل',
  },
  image_unreadable: {
    en: 'The file could not be read as an image',
    ar: 'تعذّرت قراءة الملف كصورة',
  },
  // ── Catalog (features/catalog/) ───────────────────────────────────────────
  // Name clashes are compared after folding Arabic spellings (أ/ا, ة/ه, ى/ي),
  // so the message says "already exists" even when the letters differ slightly.
  unit_name_taken: {
    en: 'A unit with this name already exists',
    ar: 'توجد وحدة بهذا الاسم مسبقاً',
  },
  attribute_type_name_taken: {
    en: 'An attribute with this name already exists',
    ar: 'توجد خاصية بهذا الاسم مسبقاً',
  },
  attribute_value_taken: {
    en: 'This attribute already has this value',
    ar: 'هذه القيمة موجودة مسبقاً في هذه الخاصية',
  },
  attribute_type_in_use: {
    en: 'Categories still allow this attribute — remove it from them first',
    ar: 'ما زالت تصنيفات تستخدم هذه الخاصية — أزلها منها أولاً',
  },
  brand_name_taken: {
    en: 'A brand with this name already exists',
    ar: 'توجد ماركة بهذا الاسم مسبقاً',
  },
  category_name_taken: {
    en: 'A category with this name already exists here',
    ar: 'يوجد تصنيف بهذا الاسم في المستوى نفسه',
  },
  category_name_taken_by_archived: {
    en: 'An archived category here uses this name — restore it instead, or choose another name',
    ar: 'تصنيف مؤرشف في المستوى نفسه يحمل هذا الاسم — استرجعه بدلاً من إنشاء جديد، أو اختر اسماً آخر',
  },
  category_too_deep: {
    en: 'Categories go three levels deep at most',
    ar: 'التصنيفات ثلاثة مستويات كحد أقصى',
  },
  category_parent_invalid: {
    en: 'A category cannot be moved under itself or one of its subcategories',
    ar: 'لا يمكن نقل تصنيف تحت نفسه أو تحت أحد تصنيفاته الفرعية',
  },
  category_parent_archived: {
    en: 'The parent category is archived — restore it first',
    ar: 'التصنيف الأب مؤرشف — استرجعه أولاً',
  },
  category_archived: {
    en: 'This category is archived — restore it before editing',
    ar: 'هذا التصنيف مؤرشف — استرجعه قبل التعديل',
  },
  category_has_children: {
    en: 'This category has subcategories — move or delete them first, or archive it',
    ar: 'تحت هذا التصنيف تصنيفات فرعية — انقلها أو احذفها أولاً، أو أرشفه',
  },
  category_has_active_children: {
    en: 'This category still has live subcategories — archive or move them first',
    ar: 'تحت هذا التصنيف تصنيفات فرعية نشطة — أرشفها أو انقلها أولاً',
  },
  category_has_products: {
    en: 'Products belong to this category — move them, or archive the category',
    ar: 'منتجات تنتمي لهذا التصنيف — انقلها، أو أرشف التصنيف',
  },
  category_has_active_products: {
    en: 'Live products belong to this category — archive or move them first',
    ar: 'منتجات نشطة تنتمي لهذا التصنيف — أرشفها أو انقلها أولاً',
  },
  category_parent_has_products: {
    en: 'The parent category holds products — move them into a subcategory first',
    ar: 'التصنيف الأب يحوي منتجات — انقلها إلى تصنيف فرعي أولاً',
  },
  category_attribute_in_use: {
    en: 'Variants in this category use an attribute being removed',
    ar: 'متغيّرات في هذا التصنيف تستخدم خاصية تحاول إزالتها',
  },
  category_not_leaf: {
    en: 'Choose the most specific category — this one has subcategories',
    ar: 'اختر التصنيف الأدق — لهذا التصنيف تصنيفات فرعية',
  },
  attribute_value_in_use: {
    en: 'Variants use this value — it cannot be deleted',
    ar: 'متغيّرات تستخدم هذه القيمة — لا يمكن حذفها',
  },
  brand_in_use: {
    en: 'Products carry this brand — archive it instead',
    ar: 'منتجات تحمل هذه الماركة — أرشفها بدلاً من الحذف',
  },

  // Products, variants, barcodes.
  product_archived: {
    en: 'This product is archived — restore it before editing',
    ar: 'هذا المنتج مؤرشف — استرجعه قبل التعديل',
  },
  product_category_archived: {
    en: 'The category is archived — choose another or restore it',
    ar: 'التصنيف مؤرشف — اختر غيره أو استرجعه',
  },
  product_attributes_not_allowed_in_category: {
    en: "This product's variants use attributes the new category does not allow",
    ar: 'متغيّرات هذا المنتج تستخدم خصائص لا يسمح بها التصنيف الجديد',
  },
  product_needs_active_variant: {
    en: 'A product on sale needs at least one active variant',
    ar: 'المنتج المعروض للبيع يحتاج متغيّراً نشطاً واحداً على الأقل',
  },
  product_needs_variant: {
    en: 'A product needs at least one variant — delete the product instead',
    ar: 'المنتج يحتاج متغيّراً واحداً على الأقل — احذف المنتج بدلاً من ذلك',
  },
  variant_attribute_not_allowed: {
    en: "This attribute is not allowed in the product's category",
    ar: 'هذه الخاصية غير مسموحة في تصنيف المنتج',
  },
  variant_attribute_repeated: {
    en: 'A variant takes one value per attribute',
    ar: 'المتغيّر يأخذ قيمة واحدة لكل خاصية',
  },
  variant_too_many_axes: {
    en: 'A product varies on three attributes at most',
    ar: 'يتفرّع المنتج على ثلاث خصائص كحد أقصى',
  },
  variant_axes_mismatch: {
    en: "All of a product's variants must use the same attributes",
    ar: 'يجب أن تستخدم كل متغيّرات المنتج الخصائص نفسها',
  },
  variant_combination_taken: {
    en: 'Another variant of this product already has this combination',
    ar: 'يوجد متغيّر آخر لهذا المنتج بالتركيبة نفسها',
  },
  variant_sku_taken: {
    en: 'This SKU is already used by another variant',
    ar: 'رمز SKU هذا مستخدم لمتغيّر آخر',
  },
  variant_unit_factor_invalid: {
    en: 'A pack unit must hold more than one base unit',
    ar: 'وحدة التعبئة يجب أن تحوي أكثر من وحدة أساس واحدة',
  },
  variant_unit_has_barcodes: {
    en: 'Remove the barcodes on this unit before removing the unit',
    ar: 'أزل الباركودات المطبوعة على هذه الوحدة قبل إزالتها',
  },
  barcode_format_invalid: {
    en: 'A barcode is 4–32 digits, capital letters or dashes',
    ar: 'الباركود من ٤ إلى ٣٢ رقماً أو حرفاً لاتينياً أو شَرطة',
  },
  barcode_checksum_invalid: {
    en: 'The check digit is wrong — the code was probably mistyped',
    ar: 'رقم التحقق خاطئ — الأرجح أن الكود كُتب خطأً',
  },
  barcode_on_other_product: {
    en: 'This barcode is already on another product. Search the catalogue by this code to open it, or print an internal label for this one.',
    ar: 'هذا الباركود مستخدم على منتج آخر. ابحث بالكتالوج بهذا الرمز لتفتحه، أو اطبع ملصقاً داخلياً لهذا المنتج.',
  },
  barcode_already_on_unit: {
    en: 'This unit already carries this barcode',
    ar: 'هذه الوحدة تحمل هذا الباركود مسبقاً',
  },
  // ── Stock and suppliers (inventory_suppliers.md §٢–§٨) ──
  supplier_name_taken: {
    en: 'A supplier with this name already exists',
    ar: 'يوجد مورد بهذا الاسم مسبقاً',
  },
  supplier_archived: {
    en: 'This supplier is archived — restore it first',
    ar: 'هذا المورد مؤرشف — استعده أولاً',
  },
  supplier_has_invoices: {
    en: 'This supplier has purchase invoices — archive instead of deleting',
    ar: 'لهذا المورد فواتير شراء — أرشفه بدل حذفه',
  },
  receipt_rate_required: {
    en: 'A dollar invoice needs the exchange rate used on it',
    ar: 'فاتورة بالدولار تحتاج سعر الصرف المستعمل فيها',
  },
  receipt_unit_mismatch: {
    en: 'That unit is not one of this item’s units',
    ar: 'هذه الوحدة ليست من وحدات هذا الصنف',
  },
  receipt_cost_invalid: {
    en: 'The cost of one line could not be computed',
    ar: 'تعذّر حساب تكلفة أحد السطور',
  },
  receipt_variant_unknown: {
    en: 'One line points at an item that does not exist',
    ar: 'أحد السطور يشير إلى صنف غير موجود',
  },
  receipt_product_archived: {
    en: 'That product is archived — stock cannot be received into it',
    ar: 'هذا المنتج مؤرشف — لا يمكن استلام بضاعة عليه',
  },
  adjustment_variant_unknown: {
    en: 'One line points at an item that does not exist',
    ar: 'أحد السطور يشير إلى صنف غير موجود',
  },
  adjustment_not_pending: {
    en: 'This document was already decided',
    ar: 'هذا المستند حُسم من قبل',
  },
  inventory_scope_denied: {
    en: 'You cannot approve stock differences at this branch',
    ar: 'لا تملك اعتماد فروق المخزون بهذا الفرع',
  },
  stock_qty_invalid: {
    en: 'The quantity must be above zero',
    ar: 'الكمية يجب أن تكون أكبر من صفر',
  },
  product_has_movements: {
    en: "This product has stock movements — archive it instead of deleting",
    ar: "لهذا المنتج حركات مخزون — أرشفه بدل حذفه",
  },
  // ── Returns to supplier (inventory_suppliers.md §٧) ──
  return_not_on_receipt: {
    en: 'That item is not on this invoice',
    ar: 'هذا الصنف ليس على هذه الفاتورة',
  },
  return_exceeds_receipt: {
    en: 'More than this invoice brought in',
    ar: 'أكثر ممّا جاء بهذه الفاتورة',
  },
  return_exceeds_stock: {
    en: 'The branch does not hold that much',
    ar: 'لا يوجد بالفرع هذا القدر',
  },
  // ── Branch drafts (inventory_suppliers.md §٢) ──
  /** The customer chose a branch that is closed, archived, or gone. */
  branch_not_shoppable: {
    en: 'This branch is not open for shopping',
    ar: 'هذا الفرع غير متاح للتسوّق — اختر فرعاً آخر',
  },
  draft_already_decided: {
    en: 'This draft has already been decided',
    ar: 'تمّ البتّ بهذه المسودة من قبل',
  },
  draft_has_stock: {
    en: 'This draft already holds stock — merge it into a product instead',
    ar: 'هذه المسودة تحمل مخزوناً — ادمجها بمنتج بدل حذفها',
  },
  // ── العروض (store_system.md §٥) ──
  /** النوع يقرّر أي الحقول إلزامي، والرسالة تسمّي الحقل الناقص لا «بيانات غير صالحة». */
  promotion_percent_required: {
    en: 'A percentage promotion needs a percent between 0 and 100',
    ar: 'عرض النسبة يحتاج نسبةً بين ٠ و١٠٠',
  },
  promotion_amount_required: {
    en: 'An amount promotion needs an amount above zero',
    ar: 'عرض المبلغ يحتاج مبلغاً أكبر من صفر',
  },
  promotion_tiers_required: {
    en: 'A tiered promotion needs at least one tier',
    ar: 'عرض الشرائح يحتاج شريحةً واحدة على الأقل',
  },
  promotion_tier_qty_invalid: {
    en: 'A tier starts at a quantity above zero',
    ar: 'الشريحة تبدأ من كمية أكبر من صفر',
  },
  promotion_tier_value_invalid: {
    en: 'A tier carries either a percent or an amount — not both and not neither',
    ar: 'الشريحة تحمل نسبةً أو مبلغاً — لا الاثنين ولا لا شيء',
  },
  promotion_bxgy_required: {
    en: 'Buy X get Y needs both quantities above zero',
    ar: '«اشترِ X خذ Y» يحتاج الكميتين أكبر من صفر',
  },
  promotion_branches_required: {
    en: 'A branch-scoped promotion needs at least one branch',
    ar: 'عرض الفروع يحتاج فرعاً واحداً على الأقل',
  },
  /** السقف يُرفض ويُسمّى: «مرفوض» بلا رقمٍ يجعل المحاولة التالية تخميناً. */
  promotion_above_branch_cap: {
    en: 'This promotion discounts more than the branch is allowed to give',
    ar: 'خصم هذا العرض يتجاوز سقف الفرع',
  },
  promotion_archived: {
    en: 'This promotion is archived — restore it before editing',
    ar: 'هذا العرض مؤرشف — أعِده قبل تعديله',
  },
  // ── نقطة البيع (orders_delivery.md §الفوترة · store_system.md §٦) ──
  /** الفاتورة المسدَّدة لا تُعدَّل ولا تُحذف: الإلغاء بمستندٍ معاكس. */
  sale_already_paid: {
    en: 'This sale is already paid — cancel it with a return instead',
    ar: 'هذه الفاتورة مسدَّدة — إلغاؤها يكون بمرتجع لا بتعديلها',
  },
  sale_voided: {
    en: 'This sale was cancelled',
    ar: 'هذه السلّة أُلغيت',
  },
  sale_empty: {
    en: 'An empty sale cannot be paid',
    ar: 'لا تُسدَّد سلّة فارغة',
  },
  sale_product_not_sellable: {
    en: 'This product is not for sale',
    ar: 'هذا الصنف غير معروض للبيع',
  },
  /** «غير مسعَّر» عطلٌ عندنا — والكاشير يحتاج أن يعرف أن الجواب تسعيرٌ لا إعادة مسح. */
  sale_item_unpriced: {
    en: 'This item has no price at this branch — price it first',
    ar: 'هذا الصنف بلا سعر بهذا الفرع — يحتاج تسعيراً',
  },
  /** الرقم يقول كم بقي، فلا تكون المحاولة التالية تخميناً. */
  sale_underpaid: {
    en: 'The payments do not cover the sale',
    ar: 'المدفوع لا يغطّي الفاتورة',
  },
  sale_discount_reason_required: {
    en: 'A manual discount needs a reason',
    ar: 'الخصم اليدوي يحتاج سبباً',
  },
  sale_discount_needs_approval: {
    en: 'This discount is above your ceiling — a manager must approve it',
    ar: 'هذا الخصم فوق سقفك — يحتاج موافقة مدير',
  },
  /** فوق أعلى سقفٍ بالمنظمة: لا أحد يوافق، فاستدعاء مديرٍ انتظارٌ بلا جدوى. */
  sale_discount_above_ceiling: {
    en: 'This discount is above what anyone may approve',
    ar: 'هذا الخصم فوق ما يملك أحدٌ الموافقة عليه',
  },
  sale_approver_cap_too_low: {
    en: 'This approver may not approve that much',
    ar: 'سقف هذا الموافِق أقلّ من الخصم المطلوب',
  },
  /** رفضٌ واحد لكل الأسباب: تمييزها يقول لمن يجرّب أي البريدين موجود. */
  sale_approval_refused: {
    en: 'Approval was refused',
    ar: 'الموافقة مرفوضة',
  },
  sale_credit_needs_customer: {
    en: 'Credit needs a named customer',
    ar: 'الآجل والرصيد يحتاجان زبوناً مسمّى',
  },
  sale_credit_insufficient: {
    en: 'Not enough customer credit',
    ar: 'رصيد الزبون لا يكفي',
  },
  sale_credit_limit_exceeded: {
    en: 'Above this customer credit limit',
    ar: 'فوق سقف آجل هذا الزبون',
  },
  // ── المرتجع (orders_delivery.md §٢) ──
  /** سلّةٌ لم تُسدَّد لا يُرَدّ عنها مال: لم يدخل الدرج شيء. */
  return_sale_not_paid: {
    en: 'Only a paid sale can be returned',
    ar: 'لا يُرَدّ إلا عن فاتورة مسدَّدة',
  },
  /** المهلة انتهت — **وليست رفضاً قاطعاً**: مديرٌ يوافق على نفس الجهاز. */
  return_window_passed: {
    en: 'This sale is past the return window — a manager must approve',
    ar: 'انتهت مهلة الإرجاع لهذه الفاتورة — تحتاج موافقة مدير',
  },
  /** الرقم يسافر مع الرفض: «مرفوض» بلا عددٍ يجعل المحاولة التالية تخميناً. */
  return_above_returnable: {
    en: 'That is more than what is left to return',
    ar: 'الكمية أكبر مما بقي قابلاً للإرجاع',
  },
  return_line_not_in_sale: {
    en: 'That line is not on this sale',
    ar: 'هذا السطر ليس بهذه الفاتورة',
  },
  return_qty_invalid: {
    en: 'A returned quantity must be above zero',
    ar: 'كمية الإرجاع تكون أكبر من صفر',
  },
  return_empty: {
    en: 'A return needs at least one line',
    ar: 'المرتجع يحتاج سطراً واحداً على الأقل',
  },
  /** رصيدٌ لمن لا حساب له مالٌ لا يعود إليه أبداً. */
  return_credit_needs_customer: {
    en: 'Store credit needs a named customer — refund in cash instead',
    ar: 'الرصيد يحتاج زبوناً مسمّى — أو استردّ نقداً',
  },
  ledger_amount_required: {
    en: 'A ledger entry needs an amount',
    ar: 'القيد يحتاج مبلغاً',
  },
  // ── السلّة والطلب الإلكتروني (orders_delivery.md) ──
  cart_qty_required: {
    en: 'A cart line needs a quantity',
    ar: 'أدخل الكمية المطلوبة',
  },
  order_cart_empty: {
    en: 'An empty cart cannot be confirmed',
    ar: 'السلّة فارغة — أضف صنفاً قبل التأكيد',
  },
  /**
   * **«غير مسعَّر» لا تُقال للزبون**: عطلٌ عندنا لا حقيقة عن البضاعة، وقولُه
   * له يجعله يظنّ الصنف ممنوعاً — والجواب أن يجرّب فرعاً آخر.
   */
  order_item_unavailable: {
    en: 'An item in the cart is not available at this branch',
    ar: 'أحد الأصناف غير متوفّر بهذا الفرع — احذفه أو بدّل الفرع',
  },
  /** الرقم يسافر مع الرفض فلا يخفّض الكمية تخميناً. */
  order_not_enough_stock: {
    en: 'Not enough stock for an item in the cart',
    ar: 'الكمية المطلوبة من أحد الأصناف أكبر من المتوفّر',
  },
  order_account_not_active: {
    en: 'This account cannot place an order',
    ar: 'لا يمكن لهذا الحساب إنشاء طلب',
  },
  /**
   * سُلِّم أو أُلغي أو انتهت مهلته — **والحالة تسافر بالرد** فتُقال بالاسم بدل
   * «لا يمكن إتمام العملية».
   */
  order_not_open: {
    en: 'This order is already closed',
    ar: 'هذا الطلب مغلق — لا خطوة عليه',
  },
  draft_no_variant: {
    en: 'This draft has no item to merge',
    ar: 'لا يوجد صنف بهذه المسودة لدمجه',
  },
  draft_merge_self: {
    en: 'A draft cannot be merged into itself',
    ar: 'لا تُدمج المسودة بنفسها',
  },
  draft_merge_into_draft: {
    en: 'Merge into a real product, not another draft',
    ar: 'ادمجها بمنتج حقيقي لا بمسودة أخرى',
  },
  // ── Transfers and stocktakes (inventory_suppliers.md §٤–§٥) ──
  transfer_scope_denied: {
    en: 'You cannot move stock at this branch',
    ar: 'لا تملك نقل البضاعة بهذا الفرع',
  },
  transfer_same_branch: {
    en: 'A transfer needs two different branches',
    ar: 'النقل يحتاج فرعين مختلفين',
  },
  transfer_state_invalid: {
    en: 'This transfer is no longer at that step',
    ar: 'هذا السند لم يعد بهذه المرحلة',
  },
  transfer_no_discrepancy: {
    en: 'This transfer has no open difference to settle',
    ar: 'لا يوجد فرق مفتوح بهذا السند',
  },
  count_scope_denied: {
    en: 'You cannot take stock at this branch',
    ar: 'لا تملك الجرد بهذا الفرع',
  },
  count_not_open: {
    en: 'This stocktake is closed',
    ar: 'محضر الجرد مغلق',
  },
  count_not_pending: {
    en: 'This stocktake is not waiting for a decision',
    ar: 'محضر الجرد ليس بانتظار قرار',
  },
  // ── Pricing (store_system.md §١١) ──
  price_central_only: {
    en: 'This price is set centrally — it needs a pricing permission for every branch',
    ar: 'هذا السعر تحدّده الإدارة مركزياً — يحتاج صلاحية تسعير لكل الفروع',
  },
  pricing_scope_denied: {
    en: 'You cannot change prices at this branch',
    ar: 'لا تملك تعديل الأسعار بهذا الفرع',
  },
  price_band_missing: {
    en: 'No allowed range is set for this category yet — ask the administration to set it',
    ar: 'لم يُحدَّد نطاق مسموح لهذا التصنيف بعد — اطلب من الإدارة تحديده',
  },
  price_no_central: {
    en: 'Set the central price first — the allowed range is measured from it',
    ar: 'ضع السعر المركزي أولاً — النطاق المسموح يُقاس منه',
  },
  price_outside_band: {
    en: 'The price is outside the range allowed for this product',
    ar: 'السعر خارج النطاق المسموح لهذا المنتج',
  },
  wholesale_not_below_retail: {
    en: 'A wholesale price must be below the retail price',
    ar: 'سعر الجملة يجب أن يكون أقل من سعر التجزئة',
  },
  rounding_bands_invalid: {
    en: 'Rounding bands must climb, end with an open band and have positive steps',
    ar: 'شرائح التقريب يجب أن تتصاعد وتنتهي بشريحة مفتوحة وخطواتها موجبة',
  },

  /** A private file's signed link was tampered with or has expired — the app requests a fresh one. */
  file_link_invalid: {
    en: 'This file link has expired — open the file again',
    ar: 'انتهت صلاحية رابط الملف — افتح الملف من جديد',
  },
} as const satisfies Record<string, Record<Lang, string>>;

export type MessageKey = keyof typeof MESSAGES;

/** Looks up `key` for `lang`; falls back to `fallback` (the ApiError's own English message) if the key is unknown. */
export function resolveMessage(key: string | undefined, lang: Lang, fallback: string): string {
  if (!key) return fallback;
  const entry = (MESSAGES as Record<string, Record<Lang, string> | undefined>)[key];
  return entry?.[lang] ?? fallback;
}
