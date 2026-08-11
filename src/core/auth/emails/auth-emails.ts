import type { Lang } from '../../i18n/messages.js';
import type { EmailMessage } from '../ports/email-sender.js';
import { authConfig } from '../config/auth-config.js';

/**
 * The two messages this engine sends, in every supported language.
 *
 * ## Why functions in TypeScript and not template files
 *
 * A template file needs a template engine, a loader, a cache and a rendering
 * error path — four moving parts for two messages whose only variables are a
 * code and a number of minutes. Functions give compile-time checking instead:
 * adding a language to `SUPPORTED_LANGUAGES` breaks this file until every
 * message covers it, exactly as `MESSAGES` in core/i18n/messages.ts does. A
 * missing translation cannot ship silently.
 *
 * The day a message needs real layout — a logo, a branded button — this becomes
 * a template loader and the callers do not change, because they only ever see
 * `EmailMessage`.
 *
 * ## Why the language comes from the request
 *
 * Accounts store no language preference, and inventing a column for one would
 * be a second source of truth against the device setting the app already sends
 * on every call (`Accept-language` → `req.lang`, see
 * core/middleware/request-context.ts). So the mail is written in the language
 * the person was reading when they asked for it, which is the best available
 * answer and costs no schema.
 *
 * ## Why the code is in the body and not a link
 *
 * A link must know the client's URL scheme, survive being opened on a different
 * device from the one that asked, and carry the token in a place that lands in
 * browser history and referrer headers. A short code typed into the app that is
 * already open avoids all three. The alphabet and length are chosen in
 * verification.service.ts for the same reason — this file only presents them.
 */

interface CodeEmailParams {
  code: string;
  expiresInMinutes: number;
}

type Localized = Record<Lang, (p: CodeEmailParams) => EmailMessage>;

export const verifyEmailMessage: Localized = {
  ar: ({ code, expiresInMinutes }) => ({
    to: '',
    subject: 'رمز تأكيد بريدك الإلكتروني',
    text: [
      'مرحباً،',
      '',
      'لتأكيد بريدك الإلكتروني، أدخل الرمز التالي في التطبيق:',
      '',
      `    ${code}`,
      '',
      `الرمز صالح لمدة ${expiresInMinutes} دقيقة، ويُستخدم مرة واحدة فقط.`,
      '',
      'إن لم تطلب هذا الرمز فتجاهل هذه الرسالة — لن يتغيّر شيء في حسابك.',
      '',
      'لا تُشارك هذا الرمز مع أي شخص، ولن يطلبه منك أحد من فريق العمل.',
    ].join('\n'),
  }),
  en: ({ code, expiresInMinutes }) => ({
    to: '',
    subject: 'Your email verification code',
    text: [
      'Hello,',
      '',
      'To confirm your email address, enter this code in the app:',
      '',
      `    ${code}`,
      '',
      `The code is valid for ${expiresInMinutes} minutes and can be used once.`,
      '',
      'If you did not request it, ignore this message — nothing about your account changes.',
      '',
      'Never share this code. No member of our team will ever ask you for it.',
    ].join('\n'),
  }),
};

export const passwordResetMessage: Localized = {
  ar: ({ code, expiresInMinutes }) => ({
    to: '',
    subject: 'رمز استعادة كلمة المرور',
    text: [
      'مرحباً،',
      '',
      'وصلنا طلب لاستعادة كلمة مرور حسابك. أدخل الرمز التالي في التطبيق:',
      '',
      `    ${code}`,
      '',
      `الرمز صالح لمدة ${expiresInMinutes} دقيقة، ويُستخدم مرة واحدة فقط.`,
      '',
      'إن لم تطلب الاستعادة فتجاهل هذه الرسالة — كلمة مرورك الحالية تبقى كما هي.',
      '',
      'لا تُشارك هذا الرمز مع أي شخص، ولن يطلبه منك أحد من فريق العمل.',
    ].join('\n'),
  }),
  en: ({ code, expiresInMinutes }) => ({
    to: '',
    subject: 'Your password reset code',
    text: [
      'Hello,',
      '',
      'We received a request to reset your password. Enter this code in the app:',
      '',
      `    ${code}`,
      '',
      `The code is valid for ${expiresInMinutes} minutes and can be used once.`,
      '',
      'If you did not request it, ignore this message — your current password stays unchanged.',
      '',
      'Never share this code. No member of our team will ever ask you for it.',
    ].join('\n'),
  }),
};

/** Builds the verification email for [to] in [lang], with the TTL taken from configuration so the text can never contradict the enforced expiry. */
export function buildVerifyEmail(to: string, lang: Lang, code: string): EmailMessage {
  return {
    ...verifyEmailMessage[lang]({
      code,
      expiresInMinutes: authConfig.verification.ttlMinutes,
    }),
    to,
  };
}

export function buildPasswordResetEmail(to: string, lang: Lang, code: string): EmailMessage {
  return {
    ...passwordResetMessage[lang]({
      code,
      expiresInMinutes: authConfig.passwordReset.ttlMinutes,
    }),
    to,
  };
}
