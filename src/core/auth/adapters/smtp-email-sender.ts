import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../logger/logger.js';
import {
  recipientDomain,
  type EmailDeliveryFailure,
  type EmailDeliveryResult,
  type EmailMessage,
  type EmailSender,
} from '../ports/email-sender.js';

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
   * The contained failure is the port's contract, not laziness: the
   * password-reset endpoint answers 200 for every address precisely so it
   * cannot be used to discover who is registered. If a delivery failure became
   * an exception it would become a *different response* for real addresses, and
   * the oracle would return through the error path.
   *
   * Contained is not hidden — the outcome comes back as a value, so the caller
   * decides what it means. Before that existed, a provider that rejected every
   * message to an unlisted address produced a green audit trail and a user
   * staring at a code that was never sent.
   *
   * ## What is logged, and what is not
   *
   * Both the success and the failure line carry the recipient **domain**, the
   * message kind and the transport — enough to see "every gmail.com
   * verification is being rejected" without putting a person's address into
   * every backup of the log. Never the body: bodies carry verification and
   * reset codes.
   */
  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    const from = env.MAIL_FROM.length > 0 ? env.MAIL_FROM : env.SMTP_USER;
    const context = {
      provider: 'smtp' as const,
      host: env.SMTP_HOST,
      kind: message.kind,
      recipientDomain: recipientDomain(message.to),
    };

    try {
      const info: unknown = await this.transport().sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined ? { html: message.html } : {}),
      });

      const messageId = readMessageId(info);
      logger.info({ ...context, ...(messageId !== undefined ? { messageId } : {}) }, 'Email accepted by the mail server.');
      return messageId !== undefined ? { ok: true, messageId } : { ok: true };
    } catch (err) {
      const errorCode = classify(err);
      // `err` is logged whole because an SMTP error carries the server's own
      // refusal text, which is the only thing that names *why* — "sending to
      // this recipient is not allowed on your plan" is a configuration problem
      // no error code of ours could describe. It carries no credential:
      // nodemailer's error exposes the response and the command, never the
      // password it authenticated with.
      logger.error(
        { ...context, errorCode, err },
        'SMTP delivery failed — the recipient did not receive this message.',
      );
      return { ok: false, errorCode };
    }
  }
}

/**
 * Maps a nodemailer error onto the port's four buckets.
 *
 * Reads `code` first — nodemailer's own classification, set for the transport
 * failures that never reach an SMTP conversation — then falls back to the
 * server's reply code, where 5xx is a permanent refusal of the envelope. That
 * ordering matters: an auth failure carries both `EAUTH` and a 5xx reply, and
 * "your credentials are wrong" is the more actionable of the two.
 *
 * This is the only function in the codebase that knows what an SMTP error looks
 * like, which is the point — `auth.service.ts` sees `'rejected'` and nothing
 * about mail servers.
 */
function classify(err: unknown): EmailDeliveryFailure {
  const e = err as { code?: unknown; responseCode?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';

  switch (code) {
    case 'EAUTH':
      return 'auth';
    case 'EENVELOPE':
    case 'EMESSAGE':
      return 'rejected';
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'ETIMEDOUT':
    case 'EDNS':
      return 'connection';
    default:
      break;
  }

  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : 0;
  if (responseCode >= 500) return 'rejected';
  if (responseCode >= 400) return 'connection'; // 4xx is "try again later"
  return 'unknown';
}

/** Nodemailer's `SentMessageInfo` is transport-dependent and typed `any`; this narrows it without trusting it. */
function readMessageId(info: unknown): string | undefined {
  const id = (info as { messageId?: unknown } | null | undefined)?.messageId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
