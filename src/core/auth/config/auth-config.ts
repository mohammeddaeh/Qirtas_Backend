import { env } from '../../config/env.js';

/**
 * Every knob the authentication engine turns, in one place.
 *
 * ## Why a module and not scattered constants
 *
 * These values differ per *deployment*, not per *codebase*: a staff back-office
 * wants a 15-minute verification code and a 7-day session; a consumer app wants
 * the opposite. Before this file the numbers lived as `const` literals inside
 * five different services (`RESET_CODE_TTL_MINUTES` in users.service.ts,
 * `MAX_ATTEMPTS` in three rate-limit middlewares, `IDLE_TIMEOUT_MS` in
 * auth.ts) — so tuning one policy meant finding it first.
 *
 * ## Why the values are read here and not inline from `env`
 *
 * `env` is validated once at boot (core/config/env.ts). Reading it through this
 * module gives every policy a *named* meaning — `auth.verification.ttlMinutes`
 * says what 15 is for; `env.EMAIL_VERIFICATION_TTL_MINUTES` says only where it
 * came from. It also means a future app can swap this module wholesale without
 * touching the services that consume it.
 *
 * Nothing here is a secret. Secrets (SMTP credentials) stay in `env` and are
 * read only by the adapter that needs them, so they cannot leak into a log line
 * that dumps "the auth config".
 */

/**
 * What email verification means for this deployment.
 *
 * - `off`      — the flow is not served at all; accounts are created verified.
 * - `optional` — codes are issued and verifiable, but nothing is gated on it.
 * - `required` — an unverified account cannot progress (see `registerAccount`).
 *
 * Qirtas runs `required`: an unverified registration never reaches the admin
 * review queue, which is what stops the queue being floodable with addresses
 * nobody owns. A template consumer that has no mail server yet sets `off` and
 * the rest of the system behaves exactly as it did before this module existed.
 */
export type EmailVerificationMode = 'off' | 'optional' | 'required';

export const authConfig = {
  session: {
    /**
     * A session with no request in this window is expired and deleted.
     * Measured from `last_active_at`, so it slides forward with use.
     */
    idleTimeoutMinutes: env.SESSION_IDLE_TIMEOUT_MINUTES,
    /**
     * Hard ceiling regardless of activity — a session older than this dies even
     * if used every minute.
     *
     * The idle timeout alone cannot express "this credential has lived long
     * enough": a device that polls in the background renews it forever, so a
     * token stolen from such a device is effectively permanent. The absolute
     * cap is what bounds that, and rotation (below) is what keeps it from being
     * felt by a legitimate user — the session's *lifetime* ends, the user's
     * *presence* does not.
     */
    absoluteTimeoutDays: env.SESSION_ABSOLUTE_TIMEOUT_DAYS,
    /**
     * How old a token may get before `POST /auth/refresh` will mint a new one.
     *
     * Rotation limits the useful life of a leaked token without asking the user
     * to sign in again. Below this age refresh is a no-op that returns the same
     * token — otherwise a client that calls refresh on every launch would
     * generate a new row's worth of churn per launch for no gain.
     */
    rotateAfterHours: env.SESSION_ROTATE_AFTER_HOURS,
  },

  verification: {
    mode: env.EMAIL_VERIFICATION_MODE as EmailVerificationMode,
    /**
     * Short by design. The code travels by email and is typed within a minute
     * or two by a person who just asked for it; a long window only widens the
     * period in which a leaked mailbox is worth attacking.
     */
    ttlMinutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
    /**
     * Wrong guesses allowed against a single issued code before it is burned.
     *
     * This is the limit that actually protects a 6-digit code — the per-IP rate
     * limiter does not, because an attacker with a pool of addresses never
     * fills one IP bucket. Bound to the *code*, so it survives IP rotation.
     */
    maxAttempts: env.EMAIL_VERIFICATION_MAX_ATTEMPTS,
    /** Minimum gap between two "send me another code" requests for one account. */
    resendCooldownSeconds: env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  },

  passwordReset: {
    ttlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    /** Same reasoning as `verification.maxAttempts` — per-code, not per-IP. */
    maxAttempts: env.PASSWORD_RESET_MAX_ATTEMPTS,
    resendCooldownSeconds: env.PASSWORD_RESET_RESEND_COOLDOWN_SECONDS,
  },

  password: {
    // `relaxed` = development only (env.ts refuses it in production): any
    // non-empty password, so test accounts can be `12345678`.
    minLength: env.PASSWORD_POLICY === 'relaxed' ? 1 : env.PASSWORD_MIN_LENGTH,
    /**
     * Composition rules stay deliberately mild: one letter, one digit.
     *
     * Length is what makes a password hard to guess; symbol-class requirements
     * mostly make it hard to remember, which is how `P@ssw0rd!` became the most
     * common "strong" password in every breach corpus. The server's job is to
     * refuse the genuinely trivial, not to teach.
     */
    requireLetter: env.PASSWORD_POLICY !== 'relaxed',
    requireDigit: env.PASSWORD_POLICY !== 'relaxed',
    maxLength: 255,
  },
} as const;

/** Convenience — the three call sites that ask this question read better for it. */
export function isEmailVerificationEnforced(): boolean {
  return authConfig.verification.mode === 'required';
}

/** Whether verification codes should be issued at all (both `optional` and `required` issue them). */
export function isEmailVerificationEnabled(): boolean {
  return authConfig.verification.mode !== 'off';
}
