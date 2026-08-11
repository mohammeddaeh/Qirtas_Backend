import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../logger/logger.js';
import type { EmailMessage, EmailSender } from '../ports/email-sender.js';

/**
 * SMTP transport — the one adapter that touches a network.
 *
 * ## Why SMTP and not a provider SDK
 *
 * The deployment sends through an organisation mail server
 * (`webmail.mow.gov.sy`) and may later send through Gmail. Both speak SMTP, so
 * moving between them is a change of five environment variables and no code:
 *
 * ```
 * organisation  SMTP_HOST=webmail.mow.gov.sy  SMTP_PORT=465  SMTP_SECURE=true
 * Gmail         SMTP_HOST=smtp.gmail.com      SMTP_PORT=587  SMTP_SECURE=false
 * ```
 *
 * A provider SDK (SendGrid, SES, Resend) would have bought nothing here and
 * cost a rewrite at exactly the moment the provider changed — which is the
 * event this design is for. If an HTTP mail API is ever required, it is a new
 * `EmailSender` implementation beside this one, not a change to it.
 *
 * ## Why the transporter is lazy
 *
 * `createTransport` opens no socket, but constructing it at import time would
 * make an unconfigured environment fail during module loading — before the
 * logger and error handler exist, producing a stack trace instead of the clear
 * refusal `LogEmailSender` gives. Built on first send, reused afterwards
 * (nodemailer pools connections internally).
 */
export class SmtpEmailSender implements EmailSender {
  private transporter: Transporter | undefined;

  private transport(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        // Implicit TLS on 465, STARTTLS on 587. Nodemailer upgrades a `false`
        // connection automatically when the server advertises STARTTLS, so this
        // flag selects the mode rather than choosing between TLS and plaintext.
        secure: env.SMTP_SECURE,
        // Omitted entirely when empty: some internal relays accept mail from a
        // trusted network with no authentication at all, and passing empty
        // credentials makes those servers reject the session outright.
        ...(env.SMTP_USER.length > 0
          ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
          : {}),
      });
    }
    return this.transporter;
  }

  /**
   * Sends [message], never throwing.
   *
   * The swallowed failure is the port's contract, not laziness: the
   * password-reset endpoint answers 200 for every address precisely so it
   * cannot be used to discover who is registered. If a delivery failure became
   * an exception it would become a *different response* for real addresses, and
   * the oracle would return through the error path.
   *
   * The failure is logged with the recipient and the SMTP error, and never with
   * the body — bodies carry verification and reset codes.
   */
  async send(message: EmailMessage): Promise<void> {
    const from = env.MAIL_FROM.length > 0 ? env.MAIL_FROM : env.SMTP_USER;

    try {
      await this.transport().sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined ? { html: message.html } : {}),
      });
    } catch (err) {
      logger.error(
        { err, to: message.to, subject: message.subject },
        'SMTP delivery failed — the recipient did not receive this message.',
      );
    }
  }
}
