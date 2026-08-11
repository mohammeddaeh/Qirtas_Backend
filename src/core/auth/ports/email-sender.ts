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
 * `PasswordResetDelivery` is kept and reimplemented on top of this, so no
 * existing caller changes (core/notifications/password-reset-delivery.ts).
 *
 * ## What an implementation must guarantee
 *
 * - **Never throw for an unknown or undeliverable address.** The password-reset
 *   flow answers 200 whether or not the address is registered, precisely so it
 *   cannot be used to test who has an account here. If a send failure became an
 *   exception, that flow would answer differently for real addresses and the
 *   oracle would be back — through the error path instead of the success path.
 *   Log the failure; do not surface it.
 * - **Never log the message body.** Bodies carry verification codes and reset
 *   codes, which are temporary passwords.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always present — some clients and most mail-security scanners only read this. */
  text: string;
  /** Optional HTML body. When absent the transport sends text only, which is a fine email. */
  html?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
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
