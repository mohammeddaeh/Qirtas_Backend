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
   * Where rate-limit counters live — `memory` (default) or `postgres`.
   *
   * **Set this to `postgres` before running more than one instance.** The
   * memory store keeps its `Map` per process, so a load balancer across N
   * replicas turns a limit of five attempts into 5×N — and a deploy or crash
   * clears every counter. Neither shows up as an error, in a log line, or in
   * any test that runs on one machine. The only party who ever observes the
   * difference is the one guessing passwords.
   *
   * `postgres` is correct across replicas and restarts, at the cost of one
   * upsert per guarded request. Guarded requests are login, registration,
   * password reset and verification — never a hot path, and all of them touch
   * the database in the same round trip anyway.
   *
   * Deliberately not Redis, and no dependency was added for it: this project
   * already runs Postgres, and a second piece of infrastructure to count login
   * attempts is a cost most deployments should not pay. `RateLimitStore` is a
   * three-method interface if you want one anyway.
   */
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),

  /**
   * How many reverse proxies sit in front of this server (0 = none).
   *
   * Every per-IP limiter reads `req.ip`. Behind a proxy that is the PROXY's
   * address unless Express is told to look past it — so with this unset, every
   * customer in the country shares one registration bucket and the fifth
   * sign-up of the hour locks everybody out. Set it to the real hop count
   * (1 for a single nginx / load balancer); never higher than the truth, or a
   * client can forge its own address with `X-Forwarded-For`.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  /**
   * Sign-ups per IP per hour. Two numbers because two populations:
   * employees register rarely and each one lands in an admin's review queue
   * (so the tight default protects a human's attention), while shoppers sit
   * behind carrier-grade NAT and office networks where dozens share one
   * address (so a tight cap would refuse real customers after the first few).
   */
  STAFF_REGISTER_RATE_LIMIT: z.coerce.number().int().min(1).default(5),
  CUSTOMER_REGISTER_RATE_LIMIT: z.coerce.number().int().min(1).default(30),

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
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(1).default(8),

  /**
   * `strict` (default) — length >= PASSWORD_MIN_LENGTH (8+), one letter, one digit.
   * `relaxed` — **development only**: any non-empty password is accepted
   * (e.g. `12345678`), so test accounts can be typed by hand. Refused when
   * NODE_ENV=production (see the check below the schema) — a weak-password
   * switch that could ride into a real deployment is not a dev convenience.
   */
  PASSWORD_POLICY: z.enum(['strict', 'relaxed']).default('strict'),

  /**
   * Key that seals TOTP secrets in the database and signs login challenges.
   * **Required in production** (the app refuses to start a second-factor
   * operation without it). Any long random string; changing it invalidates
   * every enrolled authenticator, so treat it like the database password.
   */
  /**
   * Path to the Firebase **service account** JSON that lets this server send
   * push notifications. Keep the file outside the repository; only its path goes
   * in `.env`. Unset = pushes are written to the log instead of delivered.
   */
  FCM_SERVICE_ACCOUNT_PATH: z.string().min(1).optional(),

  // ── File storage (core/media/) ────────────────────────────────────────────
  /**
   * Where uploaded files live. `local` is the only driver today: a directory on
   * this machine. The code writes to the `StorageDriver` port, never to a path,
   * so moving to MinIO/S3 later is a new adapter plus this value — no caller
   * changes.
   */
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  /** Root directory for `local`, relative to the process cwd. Kept out of git (`.gitignore`). */
  STORAGE_LOCAL_ROOT: z.string().min(1).default('storage'),
  /**
   * HMAC key that signs short-lived links to **private** files (a customer's
   * print document, which may be an ID copy). Required in production. Unset in
   * development = a random key per process, so links die on restart — harmless
   * for a developer, unacceptable for a deployment.
   */
  STORAGE_SIGNING_KEY: z.string().min(32).optional(),
  MFA_ENCRYPTION_KEY: z.string().min(16).optional(),
  /**
   * Whether roles that must have a second factor are *forced* to enroll
   * (`true`/`false`). Unset = **off** (deferred proposal, docs/reference/mfa.md).
   * Accounts that HAVE enrolled are challenged either way.
   */
  MFA_ENFORCE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /**
   * Whether staff may **enroll** a second factor at all (`true`/`false`).
   * Unset = **closed** — the app has no MFA screens yet, and an account
   * enrolled through the API would be locked out of it. `MFA_ENFORCE=true`
   * opens enrollment too. See `core/auth/mfa/enrollment-gate.ts`.
   */
  MFA_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),

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
  MAIL_TRANSPORT: z.enum(['auto', 'smtp', 'smtp2', 'log']).default('auto'),

  // ── Fallback mail server ──────────────────────────────────────────────────
  // A second SMTP account tried when the first fails (down, auth broken, port
  // blocked, recipient refused). Same shape as SMTP_*; empty SMTP2_HOST = no
  // fallback. `MAIL_TRANSPORT=smtp2` forces this one alone, to test it.
  //   Gmail (app password) → SMTP2_HOST=smtp.gmail.com SMTP2_PORT=587 SMTP2_SECURE=false
  SMTP2_HOST: z.string().default(''),
  SMTP2_PORT: z.coerce.number().int().positive().default(587),
  SMTP2_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP2_USER: z.string().default(''),
  SMTP2_PASS: z.string().default(''),
  /** Sender shown by the fallback. Must be an address its account may send as (Gmail rewrites others). */
  MAIL2_FROM: z.string().default(''),
});

const parsed = envSchema
  .refine((e) => !(e.NODE_ENV === 'production' && e.PASSWORD_POLICY === 'relaxed'), {
    message: 'PASSWORD_POLICY=relaxed is not allowed when NODE_ENV=production',
    path: ['PASSWORD_POLICY'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.STORAGE_SIGNING_KEY === undefined), {
    message: 'STORAGE_SIGNING_KEY is required when NODE_ENV=production',
    path: ['STORAGE_SIGNING_KEY'],
  })
  .refine((e) => e.PASSWORD_POLICY === 'relaxed' || e.PASSWORD_MIN_LENGTH >= 8, {
    message: 'PASSWORD_MIN_LENGTH below 8 requires PASSWORD_POLICY=relaxed',
    path: ['PASSWORD_MIN_LENGTH'],
  })
  .safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
