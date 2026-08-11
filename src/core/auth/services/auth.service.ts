import { BusinessError, ForbiddenError, UnauthorizedError } from '../../http/api-error.js';
import type { Lang } from '../../i18n/messages.js';
import { accountStore, type AuthAccount } from '../ports/account-store.js';
import { emailSender } from '../ports/email-sender.js';
import { getAuthProvider } from '../ports/auth-provider.js';
import { AUTH_EVENT, recordSecurityEvent } from '../ports/security-event-sink.js';
import { authConfig, isEmailVerificationEnabled } from '../config/auth-config.js';
import { buildPasswordResetEmail, buildVerifyEmail } from '../emails/auth-emails.js';
import * as sessionService from './session.service.js';
import * as verificationService from './verification.service.js';
import { hashPassword, verifyPassword } from './password.service.js';
import type { SessionRow } from '../schemas/sessions.schema.js';

/**
 * The orchestration layer: everything that happens *around* proving an
 * identity.
 *
 * Providers answer "who is this?"; this file decides what follows — whether the
 * application permits the sign-in, what session is opened, what is recorded,
 * what mail goes out. Keeping that here rather than in each provider is what
 * makes adding Google or Keycloak a single file: the new provider inherits
 * every rule below without restating one of them.
 *
 * Nothing in this file knows about roles, branches, ownership or approval
 * queues. Those questions are asked through [AccountStore.canSignIn] and
 * answered by the application.
 */

/** Where the request came from — carried through to security events, never used for a decision. */
export interface RequestOrigin {
  ipAddress: string | null;
  deviceInfo: string | null;
  lang: Lang;
}

export interface SignInResult {
  account: AuthAccount;
  session: SessionRow;
  token: string;
}

/**
 * Email + password sign-in.
 *
 * ## Why a wrong password and an unknown address are the same error
 *
 * Answering "no such account" makes this endpoint a membership oracle: an
 * attacker tests addresses one at a time and learns who is registered here,
 * without ever guessing a password. Both cases therefore return one
 * `invalid_credentials` 401, and the local provider additionally equalises the
 * *timing* of the two (see local-auth.provider.ts) — a shared message is
 * pointless if the two paths take visibly different amounts of time.
 *
 * ## Why account-status refusals are NOT collapsed the same way
 *
 * They come after the password has been proven correct, so the caller has
 * already demonstrated they own the account. Telling them "you are suspended"
 * leaks nothing they could not learn by other means, and withholding it would
 * leave a legitimate user staring at "invalid password" for a password that is
 * in fact correct — the single most common source of unanswerable support
 * requests. The client already branches on `data.account_status`.
 */
export async function signIn(
  credentials: { email: string; password: string },
  origin: RequestOrigin,
): Promise<SignInResult> {
  const provider = getAuthProvider('local');
  if (!provider) {
    throw new BusinessError(500, 'Local authentication is not configured', 'auth_provider_missing');
  }

  const identity = await provider.authenticate(credentials);

  if (!identity) {
    await recordSecurityEvent({
      event: AUTH_EVENT.loginFailed,
      // Null on purpose: the account may not exist, and pretending otherwise
      // would mean looking it up — which is the lookup this path avoids.
      accountId: null,
      email: credentials.email,
      ipAddress: origin.ipAddress,
      deviceInfo: origin.deviceInfo,
    });
    throw new UnauthorizedError('Invalid email or password', 'invalid_credentials');
  }

  const { account } = identity;
  const decision = await accountStore().canSignIn(account);

  if (!decision.allowed) {
    await recordSecurityEvent({
      event: AUTH_EVENT.loginRefused,
      accountId: account.id,
      email: account.email,
      ipAddress: origin.ipAddress,
      deviceInfo: origin.deviceInfo,
      details: { reason: decision.reasonKey ?? 'refused' },
    });
    // The key defaults rather than being left undefined: `reasonKey` is
    // optional in the port, and a store that omits it would otherwise hand an
    // Arabic reader the English fallback. Qirtas's store always names one.
    throw new ForbiddenError(
      decision.reason ?? 'Sign-in is not permitted for this account',
      decision.data,
      decision.reasonKey ?? 'sign_in_not_permitted',
    );
  }

  // An external provider that owns the mailbox proves the address by signing
  // the user in at all; the local provider never does. Recorded here rather
  // than inside the provider so the write happens once, on the one path that
  // has both the identity and the store.
  if (identity.emailVerifiedByProvider && account.emailVerifiedAt === null) {
    await accountStore().markEmailVerified(account.id, new Date());
  }

  const { session, token } = await sessionService.createSession({
    userId: account.id,
    provider: provider.id,
    deviceInfo: origin.deviceInfo,
  });

  await recordSecurityEvent({
    event: AUTH_EVENT.loginSuccess,
    accountId: account.id,
    email: account.email,
    ipAddress: origin.ipAddress,
    deviceInfo: origin.deviceInfo,
    details: { session_id: session.id, provider: provider.id },
  });

  return { account, session, token };
}

/** Ends the calling device's session only. Idempotent: an already-dead token is not an error, because the user's intent is satisfied either way. */
export async function signOut(token: string, origin: RequestOrigin): Promise<void> {
  const lookup = await sessionService.resolveToken(token);
  await sessionService.revokeByToken(token);

  if (lookup.ok) {
    await recordSecurityEvent({
      event: AUTH_EVENT.logout,
      accountId: lookup.session.user_id,
      ipAddress: origin.ipAddress,
      deviceInfo: origin.deviceInfo,
      details: { session_id: lookup.session.id },
    });
  }
}

export interface RefreshResult {
  token: string;
  rotated: boolean;
  expiresAt: Date;
}

/**
 * Extends the calling session, rotating its token when it is old enough.
 *
 * A dead session is a 401 rather than a silent new session: refresh must never
 * become a way to revive what the timeouts or a revocation already ended.
 */
export async function refresh(token: string, origin: RequestOrigin): Promise<RefreshResult> {
  const result = await sessionService.rotateSession(token);
  if (!result) {
    throw new UnauthorizedError('Your session has expired', 'session_expired');
  }

  if (result.rotated) {
    await recordSecurityEvent({
      event: AUTH_EVENT.sessionRotated,
      accountId: result.session.user_id,
      ipAddress: origin.ipAddress,
      deviceInfo: origin.deviceInfo,
      details: { session_id: result.session.id },
    });
  }

  return {
    token: result.token,
    rotated: result.rotated,
    expiresAt: result.session.expires_at,
  };
}

// ── Email verification ───────────────────────────────────────────────────────

/**
 * Issues a verification code and mails it.
 *
 * Silently does nothing when verification is switched off for this deployment,
 * or when the address is already proven — a second confirmation of a confirmed
 * address is noise, and re-issuing would let anyone with a session generate
 * mail to their own inbox indefinitely.
 *
 * The mail is sent after the code is stored, never before: a code that reaches
 * the user but not the database is unverifiable, and the reverse is merely a
 * resend away.
 */
export async function sendEmailVerification(
  account: AuthAccount,
  origin: RequestOrigin,
): Promise<{ sent: boolean; retryAfterSeconds?: number }> {
  if (!isEmailVerificationEnabled()) return { sent: false };
  if (account.emailVerifiedAt !== null) return { sent: false };

  const wait = await verificationService.secondsUntilResendAllowed(account.id, 'email_verify');
  if (wait > 0) return { sent: false, retryAfterSeconds: wait };

  const { code } = await verificationService.issueCode(account.id, 'email_verify');
  await emailSender().send(buildVerifyEmail(account.email, origin.lang, code));

  await recordSecurityEvent({
    event: AUTH_EVENT.emailVerificationSent,
    accountId: account.id,
    email: account.email,
    ipAddress: origin.ipAddress,
  });

  return { sent: true };
}

/**
 * Spends a verification code and records the address as proven.
 *
 * Every rejection is one error on purpose — wrong, expired, already spent and
 * out-of-attempts are indistinguishable to the caller. They all mean "ask for a
 * new code" to a legitimate user, and telling them apart would let someone
 * probe which accounts have a verification in flight. The distinction is kept
 * in the security log, where it genuinely differs.
 */
export async function verifyEmail(
  account: AuthAccount,
  code: string,
  origin: RequestOrigin,
): Promise<void> {
  if (account.emailVerifiedAt !== null) return; // already proven — idempotent, not an error

  const outcome = await verificationService.verifyCode(account.id, 'email_verify', code);

  if (!outcome.ok) {
    await recordSecurityEvent({
      event: AUTH_EVENT.emailVerificationFailed,
      accountId: account.id,
      email: account.email,
      ipAddress: origin.ipAddress,
      details: { reason: outcome.reason },
    });
    throw new BusinessError(
      422,
      'This verification code is invalid or has expired',
      'verification_code_invalid',
    );
  }

  await accountStore().markEmailVerified(account.id, new Date());

  await recordSecurityEvent({
    event: AUTH_EVENT.emailVerified,
    accountId: account.id,
    email: account.email,
    ipAddress: origin.ipAddress,
  });
}

// ── Password reset ───────────────────────────────────────────────────────────

/**
 * Step 1 — issue a reset code.
 *
 * ## Always resolves, for every address
 *
 * Answering "no such account" would make this a membership oracle in the most
 * literal way: it takes an address and, today, tells you whether it belongs to
 * someone. So an unknown address takes the same path, returns the same shape,
 * and costs the caller the same wait.
 *
 * The same reasoning covers an account the application refuses to sign in. A
 * suspended user learns nothing here — not because it would be unhelpful, but
 * because "this address exists and is suspended" is precisely what the oracle
 * was after. The cooldown is likewise swallowed rather than reported, since a
 * "please wait 40 seconds" answer confirms a code was recently sent, which
 * confirms the account exists.
 */
export async function requestPasswordReset(email: string, origin: RequestOrigin): Promise<void> {
  const account = await accountStore().findByEmail(email);
  if (!account) return;

  const decision = await accountStore().canSignIn(account);
  if (!decision.allowed && decision.reasonKey !== 'account_pending_approval') {
    // A pending account is a legitimate password-reset subject: it can sign in
    // to see its own status, so it must be able to recover the password that
    // lets it. Every other refusal (suspended, disabled, rejected) means the
    // account is not usable, and a reset would not change that.
    return;
  }

  const wait = await verificationService.secondsUntilResendAllowed(account.id, 'password_reset');
  if (wait > 0) return;

  const { code } = await verificationService.issueCode(account.id, 'password_reset');
  await emailSender().send(buildPasswordResetEmail(account.email, origin.lang, code));

  await recordSecurityEvent({
    event: AUTH_EVENT.passwordResetRequested,
    accountId: account.id,
    email: account.email,
    ipAddress: origin.ipAddress,
  });
}

/**
 * Step 2 — spend the code and set the new password.
 *
 * Ends every session for the account afterwards, and that is the substance of
 * the flow rather than housekeeping: the usual reason someone resets a password
 * is that somebody else knows it. Leaving the other party's session alive would
 * mean the reset changed nothing for exactly the person it was aimed at.
 */
export async function resetPassword(
  params: { email: string; code: string; newPassword: string },
  origin: RequestOrigin,
): Promise<void> {
  const invalid = (): never => {
    throw new BusinessError(422, 'This reset code is invalid or has expired', 'reset_code_invalid');
  };

  const account = await accountStore().findByEmail(params.email);
  // Identical to a wrong code, for the reason given in `requestPasswordReset`.
  if (!account) invalid();

  const outcome = await verificationService.verifyCode(account!.id, 'password_reset', params.code);
  if (!outcome.ok) {
    await recordSecurityEvent({
      event: AUTH_EVENT.passwordResetFailed,
      accountId: account!.id,
      email: account!.email,
      ipAddress: origin.ipAddress,
      details: { reason: outcome.reason },
    });
    invalid();
  }

  await accountStore().updatePasswordHash(account!.id, await hashPassword(params.newPassword));
  const revoked = await sessionService.revokeAllForUser(account!.id);

  await recordSecurityEvent({
    event: AUTH_EVENT.passwordResetCompleted,
    accountId: account!.id,
    email: account!.email,
    ipAddress: origin.ipAddress,
    details: { sessions_revoked: revoked },
  });
}

/**
 * Changing your own password while signed in.
 *
 * ## Why a wrong current password is 422 and not 401
 *
 * This request is authenticated, so 401 means "your session is invalid" — and
 * every client responds to that by signing the user out. Answering 401 for a
 * mistyped field would eject someone from the app over a typo, which reads as a
 * crash rather than a correction. The session is fine; one input was wrong.
 *
 * ## Why other sessions survive by default
 *
 * The user is present and chose this; signing their other devices out
 * unasked is a surprise, not a protection. [revokeOtherSessions] makes it their
 * decision — which is the honest place for it, since only they know whether the
 * change was routine or a response to something.
 */
export async function changePassword(
  params: {
    accountId: number;
    currentPassword: string;
    newPassword: string;
    revokeOtherSessions?: boolean;
    currentSessionId?: number;
  },
  origin: RequestOrigin,
): Promise<{ sessionsRevoked: number }> {
  const account = await accountStore().findById(params.accountId);
  if (!account) throw new UnauthorizedError('Authentication required', 'authentication_required');

  const valid = await verifyPassword(params.currentPassword, account.passwordHash);
  if (!valid) {
    throw new BusinessError(422, 'Your current password is incorrect', 'current_password_wrong');
  }

  if (params.currentPassword === params.newPassword) {
    throw new BusinessError(
      422,
      'The new password must differ from the current one',
      'password_must_differ',
    );
  }

  await accountStore().updatePasswordHash(account.id, await hashPassword(params.newPassword));

  // Any reset in flight is void: the owner has just proven they know the
  // current password, so an outstanding code can only be someone else's attempt.
  await verificationService.invalidatePending(account.id, 'password_reset');

  const sessionsRevoked = params.revokeOtherSessions
    ? await sessionService.revokeAllForUser(account.id, params.currentSessionId)
    : 0;

  await recordSecurityEvent({
    event: AUTH_EVENT.passwordChanged,
    accountId: account.id,
    email: account.email,
    ipAddress: origin.ipAddress,
    deviceInfo: origin.deviceInfo,
    details: { sessions_revoked: sessionsRevoked },
  });

  return { sessionsRevoked };
}

// ── Session management ───────────────────────────────────────────────────────

export function listSessions(accountId: number): Promise<SessionRow[]> {
  return sessionService.listSessions(accountId);
}

/**
 * Ends one of the caller's own sessions.
 *
 * A session that does not exist and one belonging to somebody else produce the
 * same 404, so iterating ids cannot be used to discover which are live.
 */
export async function revokeSession(
  accountId: number,
  sessionId: number,
  origin: RequestOrigin,
): Promise<boolean> {
  const revoked = await sessionService.revokeById(accountId, sessionId);
  if (!revoked) return false;

  await recordSecurityEvent({
    event: AUTH_EVENT.sessionRevoked,
    accountId,
    ipAddress: origin.ipAddress,
    deviceInfo: origin.deviceInfo,
    details: { session_id: sessionId },
  });
  return true;
}

/** "Sign out my other devices" — spares the caller's own session, because signing yourself out while securing your account reads as a malfunction. */
export async function revokeOtherSessions(
  accountId: number,
  currentSessionId: number,
  origin: RequestOrigin,
): Promise<number> {
  const count = await sessionService.revokeAllForUser(accountId, currentSessionId);

  await recordSecurityEvent({
    event: AUTH_EVENT.sessionRevokedAll,
    accountId,
    ipAddress: origin.ipAddress,
    deviceInfo: origin.deviceInfo,
    details: { sessions_revoked: count, kept_session_id: currentSessionId },
  });
  return count;
}

/** Exposed so the application can state the enforced policy to clients instead of restating it in the UI, where the two would drift. */
export const policy = authConfig;
