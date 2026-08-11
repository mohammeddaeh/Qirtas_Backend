import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { validate } from '../../../core/validation/validate.js';
import { requireAuth } from '../../../core/http/require-actor.js';
import { passwordResetRateLimit } from '../../../core/middleware/password-reset-rate-limit.js';
import { verificationRateLimit } from '../../../core/middleware/verification-rate-limit.js';
import {
  changePasswordBodySchema,
  forgotPasswordBodySchema,
  resetPasswordBodySchema,
  sessionIdParamsSchema,
  verifyEmailBodySchema,
} from '../dtos/auth.dto.js';
import * as authController from '../controllers/auth.controller.js';

/**
 * `/api/v1/auth/*` — everything about proving and holding an identity.
 *
 * Sign-in and sign-out deliberately live on `/users/login` and `/users/logout`
 * (features/identity): their response carries `permission_keys` and
 * `is_super_admin`, which are authorization facts this module must not know
 * about. Both delegate the authentication itself to the same `core/auth`
 * service these routes use.
 */
export const authRouter = Router();

// ── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Extends the calling session, rotating its token when it is old enough.
 *
 * **No `requireAuth`, on purpose.** An expired session leaves `req.user` null,
 * and an expiring session is exactly what calls this. The controller reads the
 * token from the header and the service decides whether it is still alive —
 * answering 401 itself when it is not.
 */
authRouter.post('/refresh', asyncHandler(authController.refresh));

/** The caller's own devices. No permission needed — these are their sessions, not anyone else's. */
authRouter.get('/sessions', requireAuth, asyncHandler(authController.listSessions));

/**
 * Ends one of the caller's own sessions. Scoped to the actor by the service,
 * never by a parameter — `:id` is checked against ownership, so passing
 * somebody else's id answers 404 exactly like a nonexistent one.
 */
authRouter.delete(
  '/sessions/:id',
  requireAuth,
  validate(sessionIdParamsSchema, 'params'),
  asyncHandler(authController.revokeSession),
);

/** "Sign out my other devices" — spares the caller's own session. Registered before `/sessions/:id` would matter only for GET; kept adjacent for readability. */
authRouter.post(
  '/sessions/revoke-others',
  requireAuth,
  asyncHandler(authController.revokeOtherSessions),
);

// ── Email verification ───────────────────────────────────────────────────────
// Authenticated: a `pending_verification` account gets a real session that
// unlocks nothing (it holds no role assignment), precisely so it can reach
// these two endpoints. Requiring the code before issuing a session would leave
// anyone who reinstalls the app with an account they can neither use nor fix.

authRouter.post(
  '/verify-email',
  requireAuth,
  validate(verifyEmailBodySchema, 'body'),
  verificationRateLimit,
  asyncHandler(authController.verifyEmail),
);

authRouter.post(
  '/resend-verification',
  requireAuth,
  verificationRateLimit,
  asyncHandler(authController.resendVerification),
);

// ── Password reset & change ──────────────────────────────────────────────────
// The first two are UNAUTHENTICATED by definition — the caller cannot sign in.
// That makes the rate limit the only thing standing between them and both a
// mail cannon and a machine-speed guessing loop; the per-code attempt ceiling
// in verification.service.ts is the other half, and the half that survives an
// attacker rotating IP addresses.

/** Always succeeds, registered address or not — see core/auth/services/auth.service.ts for why. */
authRouter.post(
  '/forgot-password',
  validate(forgotPasswordBodySchema, 'body'),
  passwordResetRateLimit,
  asyncHandler(authController.forgotPassword),
);

authRouter.post(
  '/reset-password',
  validate(resetPasswordBodySchema, 'body'),
  passwordResetRateLimit,
  asyncHandler(authController.resetPassword),
);

/**
 * Authenticated, and needs no `requirePermission`: the actor is changing their
 * OWN password, which is not a privileged action over anyone else.
 */
authRouter.post(
  '/change-password',
  requireAuth,
  validate(changePasswordBodySchema, 'body'),
  asyncHandler(authController.changePassword),
);
