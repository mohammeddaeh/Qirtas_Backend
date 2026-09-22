import { env } from '../../config/env.js';
import { ForbiddenError } from '../../http/api-error.js';

/**
 * Whether anyone may **enroll** a second factor on this deployment.
 *
 * ## Why enrollment needed a switch of its own
 *
 * MFA is a deferred proposal (docs/reference/mfa.md): built and tested here,
 * with no screen in the app. `MFA_ENFORCE` being off stopped anyone being
 * *forced* to enroll — but `/auth/mfa/setup` and `/confirm` stayed open to any
 * signed-in staff member. An account enrolled that way is challenged on every
 * sign-in from then on (`mfa_required`), and the app has no step to answer it:
 * the owner is locked out of the app by a factor they switched on themselves,
 * through a route no screen leads to.
 *
 * Open when `MFA_ENABLED=true` (opt-in enrollment) or `MFA_ENFORCE=true`
 * (forced — which needs enrollment open, or the forced accounts could never
 * comply). Turn either on only once the app's MFA screens exist.
 *
 * Only enrollment is gated. An account that is *already* enrolled keeps being
 * challenged, and can still regenerate codes or disable — closing those would
 * strand it.
 */
export function mfaEnrollmentOpen(): boolean {
  return (env.MFA_ENABLED ?? false) || (env.MFA_ENFORCE ?? false);
}

export function assertMfaEnrollmentOpen(): void {
  if (mfaEnrollmentOpen()) return;
  throw new ForbiddenError(
    'Two-factor authentication is not available yet',
    undefined,
    'mfa_not_enabled',
  );
}
