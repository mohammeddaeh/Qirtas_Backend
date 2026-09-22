import { BusinessError, ForbiddenError, UnauthorizedError } from '../../http/api-error.js';
import type { Lang } from '../../i18n/messages.js';
import type { AuthAccount } from '../ports/account-store.js';
import type { AuthRealm } from '../realm.js';
import { emailSender, type EmailDeliveryFailure } from '../ports/email-sender.js';
import { getAuthProvider } from '../ports/auth-provider.js';
import { AUTH_EVENT, recordSecurityEvent } from '../ports/security-event-sink.js';
import { authConfig, isEmailVerificationEnabled } from '../config/auth-config.js';
import { buildPasswordResetEmail, buildVerifyEmail } from '../emails/auth-emails.js';
import * as sessionService from './session.service.js';
import * as verificationService from './verification.service.js';
import { hashPassword, verifyPassword } from './password.service.js';
import * as mfaService from '../mfa/mfa.service.js';
import { readChallenge } from '../mfa/challenge.js';
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
  realm: AuthRealm,
  credentials: { email: string; password: string },
  origin: RequestOrigin,
): Promise<SignInResult> {
  const provider = getAuthProvider('local');
  if (!provider) {
    throw new BusinessError(500, 'Local authentication is not configured', 'auth_provider_missing');
  }

  const identity = await provider.authenticate(realm, credentials);

  if (!identity) {
    await recordSecurityEvent({
      realm: realm.id,
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
  const decision = await realm.store.canSignIn(account);

  if (!decision.allowed) {
    await recordSecurityEvent({
      realm: realm.id,
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
    await realm.store.markEmailVerified(account.id, new Date());
  }

  // Password proven and sign-in permitted; if the account holds a second factor
  // no session opens yet — the caller gets a receipt good only for submitting a
  // code (`completeSecondFactor`). Checked HERE, before any session row exists,
  // so there is no half-authenticated state to leak or forget to guard.
  const challenge = await mfaService.challengeIfEnrolled(realm.id, account.id);
  if (challenge) throw new mfaService.SecondFactorRequired(challenge);

  return openSession(realm, account, provider.id, origin);
}

async function openSession(
  realm: AuthRealm,
  account: AuthAccount,
  providerId: string,
  origin: RequestOrigin,
): Promise<SignInResult> {
  const { session, token } = await sessionService.createSession(realm, {
    userId: account.id,
    provider: providerId,
    deviceInfo: origin.deviceInfo,
  });

  await recordSecurityEvent({
    realm: realm.id,
    event: AUTH_EVENT.loginSuccess,
    accountId: account.id,
    email: account.email,
    ipAddress: origin.ipAddress,
    deviceInfo: origin.deviceInfo,
    details: { session_id: session.id, provider: providerId },
  });

  return { account, session, token };
}

/**
 * Second half of a two-step sign-in: a challenge from `signIn` + a code.
 *
 * Re-checks `canSignIn` — five minutes passed since the password step, and an
 * admin may have suspended the account in between.
 */
export async function completeSecondFactor(
  realm: AuthRealm,
  input: { challenge: string; code: string },
  origin: RequestOrigin,
): Promise<SignInResult> {
  const claim = readChallenge(input.challenge);
  if (!claim || claim.realm !== realm.id) {
    throw new UnauthorizedError('The sign-in step expired. Start again.', 'mfa_challenge_invalid');
  }
  const account = await realm.store.findById(claim.accountId);
  if (!account) {
    throw new UnauthorizedError('The sign-in step expired. Start again.', 'mfa_challenge_invalid');
  }
  const decision = await realm.store.canSignIn(account);
  if (!decision.allowed) {
    throw new ForbiddenError(
      decision.reason ?? 'Sign-in is not permitted for this account',
      decision.data,
      decision.reasonKey ?? 'sign_in_not_permitted',
    );
  }

  try {
    await mfaService.verifySecondFactor(realm.id, account.id, input.code);
  } catch (error) {
    await recordSecurityEvent({
      realm: realm.id,
      event: AUTH_EVENT.loginFailed,
      accountId: account.id,
      email: account.email,
      ipAddress: origin.ipAddress,
      deviceInfo: origin.deviceInfo,
      details: { reason: 'mfa_code_invalid' },
    });
    throw error;
  }

  return openSession(realm, account, 'local', origin);
}

/** Ends the calling device's session only. Idempotent: an already-dead token is not an error, because the user's intent is satisfied either way. */
export async function signOut(
  realm: AuthRealm,
  token: string,
  origin: RequestOrigin,
): Promise<void> {
  const lookup = await sessionService.resolveToken(realm, token);
  await sessionService.revokeByToken(realm, token);

  if (lookup.ok) {
    await recordSecurityEvent({
      realm: realm.id,
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
export async function refresh(
  realm: AuthRealm,
  token: string,
  origin: RequestOrigin,
): Promise<RefreshResult> {
  const result = await sessionService.rotateSession(realm, token);
  if (!result) {
    throw new UnauthorizedError('Your session has expired', 'session_expired');
  }

  if (result.rotated) {
    await recordSecurityEvent({
      realm: realm.id,
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
 *
 * ## Why the return value distinguishes three refusals
 *
 * `sent: false` alone cannot be acted on. "Verification is off", "wait 40
 * seconds" and "the mail server rejected it" are three different situations,
 * and the authenticated resend endpoint owes the caller a different answer for
 * each. Collapsing them is how `POST /auth/resend-verification` came to answer
 * "code sent" for messages the provider had refused outright.
 *
 * The failure code stays internal — it names transports, not user problems.
 * Callers translate it into their own vocabulary; none of them forward it.
 */
export interface VerificationSendResult {
  sent: boolean;
  /** Set when the refusal was the resend cooldown, so an authenticated caller can say how long. */
  retryAfterSeconds?: number;
  /** Set when a code was issued but the transport refused it. Diagnostic only — never returned to a client. */
  deliveryFailure?: EmailDeliveryFailure;
}

export async function sendEmailVerification(
  realm: AuthRealm,
  account: AuthAccount,
  origin: RequestOrigin,
  options: {
    /**
     * Skip the resend cooldown — for ONE case only: the address itself just
     * changed. The cooldown limits how often mail goes to an address; a NEW
     * address has had none, and making its owner wait out the wait that belonged
     * to the old one strands them on the code screen with nothing coming.
     */
    ignoreCooldown?: boolean;
  } = {},
): Promise<VerificationSendResult> {
  if (!isEmailVerificationEnabled()) return { sent: false };
  if (account.emailVerifiedAt !== null) return { sent: false };

  if (options.ignoreCooldown !== true) {
    const wait = await verificationService.secondsUntilResendAllowed(
      realm,
      account.id,
      'email_verify',
    );
    if (wait > 0) return { sent: false, retryAfterSeconds: wait };
  }

  const { code } = await verificationService.issueCode(realm, account.id, 'email_verify');
  const delivery = await emailSender().send(buildVerifyEmail(account.email, origin.lang, code));

  // Recorded from the delivery result, not from having reached this line. The
  // audit log is read to answer "did we send it?" — an entry written whatever
  // happened answers that question wrongly, and confidently.
  await recordSecurityEvent({
    realm: realm.id,
    event: delivery.ok ? AUTH_EVENT.emailVerificationSent : AUTH_EVENT.emailVerificationSendFailed,
    accountId: account.id,
    email: account.email,
    ipAddress: origin.ipAddress,
    ...(delivery.ok ? {} : { details: { reason: delivery.errorCode } }),
  });

  if (!delivery.ok) return { sent: false, deliveryFailure: delivery.errorCode };
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
  realm: AuthRealm,
  account: AuthAccount,
  code: string,
  origin: RequestOrigin,
): Promise<void> {
  if (account.emailVerifiedAt !== null) return; // already proven — idempotent, not an error

  const outcome = await verificationService.verifyCode(realm, account.id, 'email_verify', code);

  if (!outcome.ok) {
    await recordSecurityEvent({
      realm: realm.id,
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

  await realm.store.markEmailVerified(account.id, new Date());

  await recordSecurityEvent({
    realm: realm.id,
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
export async function requestPasswordReset(
  realm: AuthRealm,
  email: string,
  origin: RequestOrigin,
): Promise<void> {
  const account = await realm.store.findByEmail(email);
  if (!account) return;

  const decision = await realm.store.canSignIn(account);
  if (!decision.allowed && decision.reasonKey !== 'account_pending_approval') {
    // A pending account is a legitimate password-reset subject: it can sign in
    // to see its own status, so it must be able to recover the password that
    // lets it. Every other refusal (suspended, disabled, rejected) means the
    // account is not usable, and a reset would not change that.
    return;
  }

  const wait = await verificationService.secondsUntilResendAllowed(
    realm,
    account.id,
    'password_reset',
  );
  if (wait > 0) return;

  const { code } = await verificationService.issueCode(realm, account.id, 'password_reset');
  const delivery = await emailSender().send(
    buildPasswordResetEmail(account.email, origin.lang, code),
  );

  // The event tells the truth; the response does not change either way, and
  // must not. Every early `return` above is silent for the same reason this
  // branch is invisible to the caller: an endpoint that behaves differently for
  // a real address is a membership oracle regardless of *which* difference it
  // is. So the operator learns the mail failed, and the requester learns
  // exactly what an unregistered address learns.
  await recordSecurityEvent({
    realm: realm.id,
    event: delivery.ok ? AUTH_EVENT.passwordResetRequested : AUTH_EVENT.passwordResetSendFailed,
    accountId: account.id,
    email: account.email,
    ipAddress: origin.ipAddress,
    ...(delivery.ok ? {} : { details: { reason: delivery.errorCode } }),
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
  realm: AuthRealm,
  params: { email: string; code: string; newPassword: string },
  origin: RequestOrigin,
): Promise<void> {
  const invalid = (): never => {
    throw new BusinessError(422, 'This reset code is invalid or has expired', 'reset_code_invalid');
  };

  const account = await realm.store.findByEmail(params.email);
  // Identical to a wrong code, for the reason given in `requestPasswordReset`.
  if (!account) invalid();

  const outcome = await verificationService.verifyCode(
    realm,
    account!.id,
    'password_reset',
    params.code,
  );
  if (!outcome.ok) {
    await recordSecurityEvent({
      realm: realm.id,
      event: AUTH_EVENT.passwordResetFailed,
      accountId: account!.id,
      email: account!.email,
      ipAddress: origin.ipAddress,
      details: { reason: outcome.reason },
    });
    invalid();
  }

  await realm.store.updatePasswordHash(account!.id, await hashPassword(params.newPassword));
  const revoked = await sessionService.revokeAllForUser(realm, account!.id);

  await recordSecurityEvent({
    realm: realm.id,
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
  realm: AuthRealm,
  params: {
    accountId: number;
    currentPassword: string;
    newPassword: string;
    revokeOtherSessions?: boolean;
    currentSessionId?: number;
  },
  origin: RequestOrigin,
): Promise<{ sessionsRevoked: number }> {
  const account = await realm.store.findById(params.accountId);
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

  await realm.store.updatePasswordHash(account.id, await hashPassword(params.newPassword));

  // Any reset in flight is void: the owner has just proven they know the
  // current password, so an outstanding code can only be someone else's attempt.
  await verificationService.invalidatePending(realm, account.id, 'password_reset');

  const sessionsRevoked = params.revokeOtherSessions
    ? await sessionService.revokeAllForUser(realm, account.id, params.currentSessionId)
    : 0;

  await recordSecurityEvent({
    realm: realm.id,
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

export function listSessions(realm: AuthRealm, accountId: number): Promise<SessionRow[]> {
  return sessionService.listSessions(realm, accountId);
}

/**
 * Ends one of the caller's own sessions.
 *
 * A session that does not exist and one belonging to somebody else produce the
 * same 404, so iterating ids cannot be used to discover which are live.
 */
export async function revokeSession(
  realm: AuthRealm,
  accountId: number,
  sessionId: number,
  origin: RequestOrigin,
): Promise<boolean> {
  const revoked = await sessionService.revokeById(realm, accountId, sessionId);
  if (!revoked) return false;

  await recordSecurityEvent({
    realm: realm.id,
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
  realm: AuthRealm,
  accountId: number,
  currentSessionId: number,
  origin: RequestOrigin,
): Promise<number> {
  const count = await sessionService.revokeAllForUser(realm, accountId, currentSessionId);

  await recordSecurityEvent({
    realm: realm.id,
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
