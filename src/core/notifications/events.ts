import type { Lang } from '../i18n/messages.js';

/**
 * What the system tells a person about their own account, in every language.
 *
 * Only **decisions someone else made about you** live here — the things a person
 * cannot see happen because they are not looking at the app: a wholesale request
 * answered, a registration decided, an account suspended. Anything the person
 * just did themselves (signed in, changed a password) is answered on screen.
 *
 * Functions of `params` rather than templates for the same reason as
 * `core/auth/emails`: adding a language to `SUPPORTED_LANGUAGES` breaks this
 * file until every event covers it.
 */

export const NOTIFICATION = {
  wholesaleApproved: 'wholesale_approved',
  wholesaleRejected: 'wholesale_rejected',
  wholesaleRevoked: 'wholesale_revoked',
  registrationApproved: 'registration_approved',
  registrationRejected: 'registration_rejected',
  accountSuspended: 'account_suspended',
  accountReactivated: 'account_reactivated',
} as const;

export type NotificationEvent = (typeof NOTIFICATION)[keyof typeof NOTIFICATION];

export interface NotificationParams {
  /** The stated reason of a rejection/revocation — shown to the person, so it is theirs to read. */
  reason?: string | null | undefined;
}

interface Text {
  title: string;
  body: string;
}

const withReason = (base: string, reason: string | null | undefined, label: string): string =>
  reason ? `${base}\n${label}: ${reason}` : base;

const TEXT: Record<NotificationEvent, Record<Lang, (p: NotificationParams) => Text>> = {
  wholesale_approved: {
    ar: () => ({ title: 'تمت الموافقة على حساب الجملة', body: 'يمكنك الآن الاستفادة من أسعار الجملة.' }),
    en: () => ({ title: 'Wholesale account approved', body: 'You can now use wholesale prices.' }),
  },
  wholesale_rejected: {
    ar: (p) => ({
      title: 'تعذّرت الموافقة على طلب الجملة',
      body: withReason('لم نتمكن من قبول طلبك حالياً.', p.reason, 'السبب'),
    }),
    en: (p) => ({
      title: 'Wholesale request not approved',
      body: withReason('We could not approve your request at this time.', p.reason, 'Reason'),
    }),
  },
  wholesale_revoked: {
    ar: (p) => ({
      title: 'أُلغي حساب الجملة',
      body: withReason('عاد حسابك إلى أسعار التجزئة.', p.reason, 'السبب'),
    }),
    en: (p) => ({
      title: 'Wholesale account withdrawn',
      body: withReason('Your account is back on retail prices.', p.reason, 'Reason'),
    }),
  },
  registration_approved: {
    ar: () => ({ title: 'تم قبول طلب انضمامك', body: 'يمكنك الآن استخدام التطبيق بصلاحياتك.' }),
    en: () => ({ title: 'Your request was approved', body: 'You can now use the app with your role.' }),
  },
  registration_rejected: {
    ar: (p) => ({
      title: 'لم يُقبل طلب انضمامك',
      body: withReason('يمكنك تعديل الطلب وإعادة إرساله.', p.reason, 'السبب'),
    }),
    en: (p) => ({
      title: 'Your request was not approved',
      body: withReason('You can edit the request and send it again.', p.reason, 'Reason'),
    }),
  },
  account_suspended: {
    ar: () => ({ title: 'عُلِّق حسابك مؤقتاً', body: 'تواصل مع الإدارة لمعرفة التفاصيل.' }),
    en: () => ({ title: 'Your account is on hold', body: 'Contact the administration for details.' }),
  },
  account_reactivated: {
    ar: () => ({ title: 'أُعيد تفعيل حسابك', body: 'يمكنك متابعة استخدام التطبيق.' }),
    en: () => ({ title: 'Your account is active again', body: 'You can keep using the app.' }),
  },
};

export function notificationText(
  event: NotificationEvent,
  lang: Lang,
  params: NotificationParams = {},
): Text {
  return TEXT[event][lang](params);
}
