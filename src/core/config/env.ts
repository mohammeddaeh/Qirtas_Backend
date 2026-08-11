import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Session idle timeout in minutes — a session with no request in this
   * window is treated as expired (core/middleware/auth.ts). Default is a
   * placeholder (7 days); users_roles.md does not mandate a specific value —
   * tune via env, not a business-rule decision baked into code.
   */
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10080), // 7 days
  /**
   * Comma-separated browser origins allowed to call this API, e.g.
   * `https://admin.qirtas.sy,https://qirtas.sy`.
   *
   * Empty (the default) means **no browser origin is allowed** — deliberately
   * strict rather than open. The mobile client is unaffected either way: CORS
   * is a browser mechanism and native HTTP clients ignore it entirely. So a
   * wide-open policy bought nothing and cost everything the moment a web build
   * or browser admin panel appears (production_readiness.md §A3).
   */
  ALLOWED_ORIGINS: z.string().default(''),

  // ── Authentication policy ─────────────────────────────────────────────────
  // Named meanings live in core/auth/config/auth-config.ts; this block only
  // validates and defaults them. Every value here is a policy, never a secret.

  /**
   * Hard ceiling on a session's life regardless of activity.
   *
   * The idle timeout alone cannot bound a token's usefulness: a device polling
   * in the background renews it forever, so a token stolen from one is
   * effectively permanent. 30 days is long enough that a daily user never sees
   * it and short enough that an abandoned credential eventually dies.
   */
  SESSION_ABSOLUTE_TIMEOUT_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * Age at which `POST /auth/refresh` mints a replacement token.
   *
   * Below this, refresh returns the existing token unchanged — otherwise a
   * client calling refresh on every launch would churn a row per launch and
   * gain nothing.
   */
  SESSION_ROTATE_AFTER_HOURS: z.coerce.number().int().positive().default(24),

  /**
   * `off` — no verification flow, accounts are created already verified.
   * `optional` — codes are issued and verifiable, nothing is gated on it.
   * `required` — an unverified account cannot progress past registration.
   *
   * Defaults to `off` so that an existing deployment which upgrades this
   * backend without configuring SMTP keeps behaving exactly as before, rather
   * than locking every new registration behind an email that cannot be sent.
   * Qirtas sets `required` in its own env.
   */
  EMAIL_VERIFICATION_MODE: z.enum(['off', 'optional', 'required']).default('off'),
  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  PASSWORD_RESET_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PASSWORD_RESET_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  /**
   * Minimum password length. Composition rules (one letter, one digit) are
   * fixed in auth-config.ts — length is the knob worth deployment-level tuning,
   * character classes are not (see that file for why).
   */
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(8),

  // ── Mail transport ────────────────────────────────────────────────────────
  // These ARE secrets (SMTP_PASS especially) and are read only by
  // core/auth/adapters/smtp-email-sender.ts — never by auth-config.ts, so a
  // future log line that dumps "the auth config" cannot leak them.
  //
  // Switching provider is a change to these values and nothing else:
  //   organisation webmail → SMTP_HOST=webmail.mow.gov.sy SMTP_PORT=465 SMTP_SECURE=true
  //   Gmail                → SMTP_HOST=smtp.gmail.com     SMTP_PORT=587 SMTP_SECURE=false

  /** Empty (the default) selects the development log adapter — see MAIL_TRANSPORT below. */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  /** `true` for implicit TLS (port 465); `false` for STARTTLS (port 587). */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  /** Envelope From — e.g. `Qirtas <no-reply@mow.gov.sy>`. Falls back to SMTP_USER when empty. */
  MAIL_FROM: z.string().default(''),
  /**
   * `auto` (default) picks SMTP when SMTP_HOST is set and the log adapter
   * otherwise — so local development needs zero mail configuration and
   * production fails loudly instead of silently logging codes (see
   * LogEmailSender). `smtp`/`log` force one explicitly.
   */
  MAIL_TRANSPORT: z.enum(['auto', 'smtp', 'log']).default('auto'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
