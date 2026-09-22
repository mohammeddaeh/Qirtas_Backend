/**
 * How mail leaves this system.
 *
 * ## Why one general port and not a port per flow
 *
 * The project already had `PasswordResetDelivery` — a one-method interface for
 * one message type. That shape does not survive the second message: email
 * verification would have needed `EmailVerificationDelivery`, an email-change
 * confirmation a third, and each new adapter would have re-implemented the same
 * SMTP connection with a different name. The thing that varies between
 * deployments is the *transport*, not the *message*, so the transport is what
 * gets abstracted.
 *
 * `PasswordResetDelivery` (core/notifications/) was the one-method interface
 * this replaced. It was kept for a while "so an older copy of the template
 * still compiles" — which is not a reason that survives contact with a reader:
 * a second, exported, fully-documented mail port sitting beside this one reads
 * as a live alternative, and `docs/rest_api.md` did in fact still describe the
 * password-reset flow as going through it. **Deleted 2026-08-17**, with zero
 * callers; `core/notifications/` went with it.
 *
 * ## What an implementation must guarantee
 *
 * - **Never throw for an unknown or undeliverable address.** The password-reset
 *   flow answers 200 whether or not the address is registered, precisely so it
 *   cannot be used to test who has an account here. If a send failure became an
 *   exception, that flow would answer differently for real addresses and the
 *   oracle would be back — through the error path instead of the success path.
 *   Report the failure in the return value; do not raise it.
 * - **Never log the message body.** Bodies carry verification codes and reset
 *   codes, which are temporary passwords.
 *
 * ## Why `send` reports a result instead of returning `void`
 *
 * The no-throw rule above is a rule about the *HTTP response*, not about
 * *knowledge*. The first version conflated the two and returned `void`, so a
 * rejected send was indistinguishable from a delivered one at every call site:
 * `sendEmailVerification` recorded `auth.email.verification_sent` into the audit
 * log after a send that never left the building, and `POST
 * /auth/resend-verification` answered "code sent" for a code nobody could
 * receive. That was not hypothetical — a provider restriction silently dropped
 * every message to an address other than one (2026-08-12).
 *
 * So the outcome comes back as a value. Callers that must not vary their
 * response (password reset) ignore it beyond logging; callers that may
 * (the authenticated resend) act on it. Either way the *reason* stays inside
 * the server: `EmailDeliveryFailure` is a diagnostic code for logs and audit
 * rows, never a string handed to a client.
 */

/**
 * Which message this is — for logs and metrics, not for rendering.
 *
 * Carried on the message rather than passed beside it so a transport cannot be
 * called without it, and so `subject` (localized, and therefore useless as a
 * grouping key) never becomes the thing dashboards filter on.
 */
export type EmailKind = 'email_verification' | 'password_reset' | 'notification';

export interface EmailMessage {
  to: string;
  kind: EmailKind;
  subject: string;
  /** Plain-text body. Always present — some clients and most mail-security scanners only read this. */
  text: string;
  /** Optional HTML body. When absent the transport sends text only, which is a fine email. */
  html?: string;
}

/**
 * Why a message did not go out — deliberately coarse.
 *
 * These four buckets are the ones that lead to *different actions*: fix the
 * sender/recipient policy, fix the credentials, fix the network, or read the
 * log. A finer taxonomy would mean mapping every provider's error catalogue
 * here, which is exactly the provider-specific knowledge this port exists to
 * keep out of `core/auth`.
 */
export type EmailDeliveryFailure =
  /** No transport is configured at all — the message was never handed to anything. */
  | 'no_transport'
  /** The provider refused the envelope: unverified sender domain, recipient not permitted, mailbox unknown. */
  | 'rejected'
  /** The provider refused the credentials. */
  | 'auth'
  /** The provider could not be reached: DNS, TCP, TLS, timeout. */
  | 'connection'
  | 'unknown';

export type EmailDeliveryResult =
  | { ok: true; messageId?: string }
  | { ok: false; errorCode: EmailDeliveryFailure };

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}

/**
 * The part of an address that is safe to log.
 *
 * A full address in a log line is personal data in every backup that log ends
 * up in, and it buys nothing the domain does not: "every message to gmail.com
 * is being rejected" is the finding, and the local part never changes it. The
 * account id, recorded beside it, is how a specific user is traced when that is
 * genuinely needed.
 */
export function recipientDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 && at < address.length - 1 ? address.slice(at + 1).toLowerCase() : 'unknown';
}

/**
 * The wiring point — same pattern and same reasoning as `setAccountStore`.
 *
 * Swapping the organisation's mail server for Gmail is a change of environment
 * variables, not of code: both are SMTP, and `SmtpEmailSender` reads host, port,
 * TLS mode, credentials and From address from `env`. Swapping SMTP for an HTTP
 * mail API later is one new adapter file and one changed line here.
 */
let sender: EmailSender | undefined;

export function setEmailSender(implementation: EmailSender): void {
  sender = implementation;
}

export function emailSender(): EmailSender {
  if (!sender) {
    throw new Error(
      'EmailSender has not been configured. Call setEmailSender(...) during ' +
        'application composition (see src/app.ts) before serving any request.',
    );
  }
  return sender;
}
