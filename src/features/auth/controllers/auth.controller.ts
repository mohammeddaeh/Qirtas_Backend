import type { Request, Response } from 'express';
import { ok, noContentOk } from '../../../core/http/response.js';
import { actorOf } from '../../../core/http/require-customer.js';
import { BusinessError, NotFoundError, UnauthorizedError } from '../../../core/http/api-error.js';
import * as notificationsService from '../../../core/notifications/notifications.service.js';
import * as mfaService from '../../../core/auth/mfa/mfa.service.js';
import { assertMfaEnrollmentOpen } from '../../../core/auth/mfa/enrollment-gate.js';
import { verifyPassword } from '../../../core/auth/services/password.service.js';
import * as authService from '../../../core/auth/services/auth.service.js';
import { getRealm, realmForToken } from '../../../core/auth/realm.js';
import { realmForEmail } from '../../../core/auth/login-dispatch.js';
import { isEmailVerificationEnabled } from '../../../core/auth/config/auth-config.js';
import {
  toWireSession,
  type ChangePasswordBody,
  type ForgotPasswordBody,
  type MfaCodeBody,
  type RegisterPushTokenBody,
  type RemovePushTokenBody,
  type MfaDisableBody,
  type ResetPasswordBody,
  type VerifyEmailBody,
} from '../dtos/auth.dto.js';

/**
 * HTTP surface for the authentication engine.
 *
 * Thin by design: every rule lives in `core/auth`, and this file only turns
 * requests into service calls and results into the project's envelope. A rule
 * that appears here instead of there is a rule the next application does not
 * inherit.
 *
 * Sign-in and sign-out are NOT here — they stay on `/users/login` and
 * `/users/logout` in `features/identity`, because their response carries
 * `permission_keys` and `is_super_admin`, which are authorization facts this
 * module must not know about. Identity delegates the authentication itself to
 * the same `core/auth` service this file uses, so there is one implementation
 * with two callers, not two implementations.
 */

/** Request metadata every service call carries — for security events and email language, never for a decision. */
function originOf(req: Request): authService.RequestOrigin {
  return {
    ipAddress: req.ip ?? null,
    deviceInfo: req.header('User-Agent') ?? null,
    lang: req.lang,
  };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function refresh(req: Request, res: Response): Promise<void> {
  // Deliberately does NOT use requireActorId: an expired session leaves
  // `req.user` null, and refresh is exactly the endpoint an expired session
  // calls. The token is read straight from the header and the service decides
  // whether it is still alive.
  const header = req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) throw new UnauthorizedError('Authentication required', 'authentication_required');

  const tokenRealm = realmForToken(token);
  if (!tokenRealm)
    throw new UnauthorizedError('Authentication required', 'authentication_required');

  const result = await authService.refresh(tokenRealm, token, originOf(req));
  ok(res, {
    token: result.token,
    rotated: result.rotated,
    expires_at: result.expiresAt.toISOString(),
  });
}

export async function listSessions(req: Request, res: Response): Promise<void> {
  const { id: actorId, realm: realmId } = actorOf(req);
  const realm = getRealm(realmId);
  const sessions = await authService.listSessions(realm, actorId);
  ok(
    res,
    sessions.map((s) => toWireSession(s, req.session?.id ?? null)),
  );
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  const { id: actorId, realm: realmId } = actorOf(req);
  const realm = getRealm(realmId);
  const { id } = req.params as unknown as { id: number };

  // Revoking the current session is logout; the client should call that
  // instead, but refusing outright would be pedantic — the intent is
  // unambiguous either way.
  const revoked = await authService.revokeSession(realm, actorId, id, originOf(req));
  // A session that does not exist and one belonging to somebody else answer
  // identically, so iterating ids cannot reveal which are live.
  if (!revoked) throw new NotFoundError('This session no longer exists');

  noContentOk(res, 'Session revoked');
}

export async function revokeOtherSessions(req: Request, res: Response): Promise<void> {
  const { id: actorId, realm: realmId } = actorOf(req);
  const realm = getRealm(realmId);
  const currentSessionId = req.session?.id;
  if (currentSessionId === undefined) {
    throw new UnauthorizedError('Authentication required', 'authentication_required');
  }

  const count = await authService.revokeOtherSessions(
    realm,
    actorId,
    currentSessionId,
    originOf(req),
  );
  ok(res, { sessions_revoked: count }, 'Other sessions signed out');
}

// ── Email verification ───────────────────────────────────────────────────────

export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const { id: actorId, realm: realmId } = actorOf(req);
  const realm = getRealm(realmId);
  const { code } = req.body as VerifyEmailBody;

  const account = await realm.store.findById(actorId);
  if (!account) throw new UnauthorizedError('Authentication required', 'authentication_required');

  await authService.verifyEmail(realm, account, code, originOf(req));

  // Returns the account's NEW state rather than 200-with-nothing.
  //
  // Verifying an address advances the lifecycle — in Qirtas from
  // `pending_verification` to `pending_approval` — and that transition is the
  // application's rule, not the client's. Answering with an empty body would
  // leave the client to either re-derive it locally (restating a server rule it
  // will eventually get wrong) or fire a second `GET /users/me` for a fact this
  // response already knows. Same shape of decision as
  // `POST /users/me/resubmit-registration`, which returns the updated user.
  //
  // Only the three fields `core/auth` legitimately owns travel here. The full
  // user record belongs to `features/identity`, and reaching for it would put
  // an authorization-shaped payload on an authentication endpoint.
  const updated = await realm.store.findById(actorId);
  ok(
    res,
    {
      status: updated?.status ?? account.status,
      email_verified: updated?.emailVerifiedAt !== null,
      email_verified_at: updated?.emailVerifiedAt?.toISOString() ?? null,
    },
    'Email confirmed',
  );
}

export async function resendVerification(req: Request, res: Response): Promise<void> {
  const { id: actorId, realm: realmId } = actorOf(req);
  const realm = getRealm(realmId);

  if (!isEmailVerificationEnabled()) {
    throw new BusinessError(
      409,
      'Email verification is not enabled on this server',
      'verification_disabled',
    );
  }

  const account = await realm.store.findById(actorId);
  if (!account) throw new UnauthorizedError('Authentication required', 'authentication_required');

  if (account.emailVerifiedAt !== null) {
    throw new BusinessError(
      409,
      'This email address is already confirmed',
      'verification_already_verified',
    );
  }

  const result = await authService.sendEmailVerification(realm, account, originOf(req));

  // Reported honestly here, unlike in the password-reset flow: this endpoint is
  // authenticated, so telling the caller how long to wait reveals nothing they
  // do not already know about their own account. `forgot-password` must stay
  // silent for exactly the opposite reason.
  if (!result.sent && result.retryAfterSeconds !== undefined) {
    throw new BusinessError(
      429,
      'A code was just sent — please wait before requesting another',
      'verification_resend_cooldown',
    );
  }

  // A delivery failure is a real answer on this endpoint, for the same reason
  // the cooldown is: the caller holds a session for the account, so "we could
  // not send your code" tells them nothing about anyone else. Answering
  // "Verification code sent" instead — which is what this did until 2026-08-12
  // — sends someone to wait for mail that was refused, and the only signal is a
  // log line they cannot see.
  //
  // `result.deliveryFailure` is deliberately NOT forwarded: `rejected` / `auth`
  // / `connection` describe the mail server, and a user cannot act on any of
  // them. They are already in the log and the audit row, which is where an
  // operator looks.
  if (!result.sent && result.deliveryFailure !== undefined) {
    throw new BusinessError(
      502,
      'We could not send the verification email just now — please try again shortly',
      'verification_send_failed',
    );
  }

  noContentOk(res, 'Verification code sent');
}

// ── Password reset & change ──────────────────────────────────────────────────

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = req.body as ForgotPasswordBody;
  await authService.requestPasswordReset(await realmForEmailOrStaff(email), email, originOf(req));

  // Always the same answer, registered address or not — see the service for
  // why. The message is deliberately conditional-free prose: "if an account
  // exists" states the guarantee without confirming anything.
  noContentOk(res, 'If an account exists for that address, a reset code has been sent');
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const body = req.body as ResetPasswordBody;
  await authService.resetPassword(
    await realmForEmailOrStaff(body.email),
    { email: body.email, code: body.code, newPassword: body.new_password },
    originOf(req),
  );
  noContentOk(res, 'Password updated — sign in with your new password');
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const { id: actorId, realm: realmId } = actorOf(req);
  const realm = getRealm(realmId);
  const body = req.body as ChangePasswordBody;

  const result = await authService.changePassword(
    realm,
    {
      accountId: actorId,
      currentPassword: body.current_password,
      newPassword: body.new_password,
      revokeOtherSessions: body.revoke_other_sessions,
      // Passed so "sign out my other devices" spares the device issuing the
      // command — signing yourself out while securing your account reads as a
      // malfunction.
      currentSessionId: req.session?.id,
    },
    originOf(req),
  );

  ok(res, { sessions_revoked: result.sessionsRevoked }, 'Password changed');
}

/**
 * The realm whose reset flow an address belongs to. Unknown addresses fall to staff, where the flow is a silent no-op — the same answer a real address gets, so the endpoint stays no membership oracle.
 */
async function realmForEmailOrStaff(email: string) {
  return getRealm((await realmForEmail(email)) ?? 'staff');
}

// ── Second factor (TOTP) ─────────────────────────────────────────────────────

/**
 * Staff only for now. The engine is realm-generic, but the customer sign-in
 * handler does not yet know how to answer a challenge — an enrolled customer
 * would be locked out with a 500. Extending it is a deliberate step, not a side effect.
 */
function mfaActor(req: Request): { realm: 'staff'; id: number } {
  const actor = actorOf(req);
  if (actor.realm !== 'staff') {
    throw new BusinessError(403, 'Two-factor authentication is for staff accounts', 'mfa_staff_only');
  }
  return { realm: 'staff', id: actor.id };
}

export async function mfaStatus(req: Request, res: Response): Promise<void> {
  const { realm, id } = mfaActor(req);
  ok(res, await mfaService.status(realm, id));
}

export async function mfaSetup(req: Request, res: Response): Promise<void> {
  assertMfaEnrollmentOpen();
  const { realm, id } = mfaActor(req);
  const account = await getRealm(realm).store.findById(id);
  if (!account) throw new UnauthorizedError('Authentication required', 'authentication_required');
  ok(res, await mfaService.beginEnrollment(realm, id, account.email));
}

export async function mfaConfirm(req: Request, res: Response): Promise<void> {
  // Gated too: a setup begun while enrollment was open must not complete after
  // it closed.
  assertMfaEnrollmentOpen();
  const { realm, id } = mfaActor(req);
  const { code } = req.body as MfaCodeBody;
  ok(res, { recovery_codes: await mfaService.confirmEnrollment(realm, id, code) });
}

export async function mfaRegenerateCodes(req: Request, res: Response): Promise<void> {
  const { realm, id } = mfaActor(req);
  const { code } = req.body as MfaCodeBody;
  await mfaService.verifySecondFactor(realm, id, code);
  ok(res, { recovery_codes: await mfaService.regenerateRecoveryCodes(realm, id) });
}

export async function mfaDisable(req: Request, res: Response): Promise<void> {
  const { realm, id } = mfaActor(req);
  const { password, code } = req.body as MfaDisableBody;
  const account = await getRealm(realm).store.findById(id);
  if (!account || !(await verifyPassword(password, account.passwordHash))) {
    throw new BusinessError(422, 'Current password is incorrect', 'current_password_wrong');
  }
  // A required role cannot opt out — the requirement is the point.
  if (await mfaService.isRequired(realm, id)) {
    throw new BusinessError(409, 'Your role requires two-factor authentication', 'mfa_required_by_role');
  }
  await mfaService.verifySecondFactor(realm, id, code);
  await mfaService.clear(realm, id);
  ok(res, null);
}

// ── Push notification devices ────────────────────────────────────────────────

export async function registerPushToken(req: Request, res: Response): Promise<void> {
  const { realm, id } = actorOf(req);
  const body = req.body as RegisterPushTokenBody;
  await notificationsService.registerDevice({
    realm,
    accountId: id,
    token: body.token,
    platform: body.platform,
    language: body.language ?? null,
    sessionId: req.session?.id ?? null,
  });
  ok(res, null);
}

export async function removePushToken(req: Request, res: Response): Promise<void> {
  const { realm, id } = actorOf(req);
  const { token } = req.body as RemovePushTokenBody;
  await notificationsService.unregisterDevice(realm, id, token);
  ok(res, null);
}
