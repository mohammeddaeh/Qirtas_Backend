import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import { logger } from '../../../core/logger/logger.js';
import * as authService from '../../../core/auth/services/auth.service.js';
import * as sessionService from '../../../core/auth/services/session.service.js';
import { hashPassword, verifyPassword } from '../../../core/auth/services/password.service.js';
import { isEmailVerificationEnabled } from '../../../core/auth/config/auth-config.js';
import type { CustomerRow } from '../schemas/customers.schema.js';
import type { LoginRequest } from '../../../core/auth/login-dispatch.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import {
  paginated,
  type Paginated,
  type PaginationParams,
} from '../../../core/pagination/pagination.js';
import { notify, NOTIFICATION } from '../../../core/notifications/index.js';
import * as auditService from '../../identity/services/audit.service.js';
import { AUDIT, target } from '../../identity/services/audit-actions.js';
import * as branchesRepository from '../../identity/repositories/branches.repository.js';
import * as customersRepository from '../repositories/customers.repository.js';
import { customerAccountStore } from '../repositories/account-store.impl.js';
import { customerAuthRealm } from '../auth-realm.js';
import {
  toWireCustomer,
  type RegisterCustomerBody,
  type UpdateCustomerProfileBody,
  type WireCustomer,
  type CustomersFilterQuery,
  applyContactPolicy,
  type DecideWholesaleBody,
  type RevokeWholesaleBody,
  type ChangeEmailBody,
  maskEmail,
  type WireCustomerActivity,
} from '../dtos/customers.dto.js';

/**
 * What both `register` and `login` return. `account_type` is the discriminator
 * the client branches on to pick where to land — the same endpoint serves staff
 * and customers, so the response must say which one this is.
 */
export interface CustomerSessionResult {
  account_type: 'customer';
  customer: WireCustomer;
  token: string;
  session_id: number;
}

/** A display preference must still name a branch a customer can actually see — same rule as the staff registration catalog. */
async function assertPreferableBranch(branchId: number | null | undefined): Promise<void> {
  if (branchId === null || branchId === undefined) return;
  const branch = await branchesRepository.findById(branchId);
  if (!branch) throw new NotFoundError('Preferred branch not found');
  if (branchesRepository.isSelfRegisterable(branch)) return;
  throw new BusinessError(422, 'This branch cannot be selected', 'branch_not_self_registerable');
}

export async function login(
  body: LoginRequest,
  origin: authService.RequestOrigin,
): Promise<CustomerSessionResult> {
  const { account, session, token } = await authService.signIn(
    customerAuthRealm,
    { email: body.email, password: body.password },
    { ...origin, deviceInfo: body.device_info ?? origin.deviceInfo },
  );

  const row = await customersRepository.findById(account.id);
  if (!row) throw new NotFoundError('Customer not found');

  // Keep the stored language in step with the app's — see the column's note.
  // Best-effort: a failed write must never fail a sign-in that already succeeded.
  if (row.preferred_language !== origin.lang) {
    void customersRepository
      .update(row.id, { preferred_language: origin.lang })
      .catch((err: unknown) => logger.warn({ err }, 'Could not store preferred language'));
  }

  return {
    account_type: 'customer',
    customer: toWireCustomer(row),
    token,
    session_id: session.id,
  };
}

/**
 * Self-registration for a shopper.
 *
 * Active at once — there is no queue to wait in — and signed in through the
 * same `login()` every other path uses, so the sign-in refusals, the security
 * event and the response shape cannot drift from the real thing. The email is
 * NOT proven yet: browsing and profile work immediately, purchasing waits for
 * the code (`requireVerifiedCustomer`).
 */
export async function register(
  body: RegisterCustomerBody,
  origin: authService.RequestOrigin,
): Promise<CustomerSessionResult> {
  await assertPreferableBranch(body.preferred_branch_id);

  const verificationEnabled = isEmailVerificationEnabled();

  const account = await customerAccountStore.create({
    email: body.email,
    passwordHash: await hashPassword(body.password),
    // With verification switched off for the deployment there is nothing to
    // prove against, so the address counts as proven — otherwise nobody could
    // ever purchase on a server with no mail transport.
    emailVerifiedAt: verificationEnabled ? null : new Date(),
    profile: {
      first_name: body.first_name,
      last_name: body.last_name,
      phone: body.phone ?? null,
      preferred_branch_id: body.preferred_branch_id ?? null,
      terms_accepted: true,
      language: origin.lang,
    },
  });

  // Sent IN THE BACKGROUND. Registration used to wait for the mail server, so a
  // slow SMTP (seconds) froze the sign-up screen — for something the customer
  // does not need until they buy. The code is stored before this line and mailed
  // after it, so a failed send costs one "resend" tap, never a broken account.
  // The failure is logged (an operator must see a dead mail server), and swallowed
  // (the customer must not be told their sign-up failed when it did not).
  void authService
    .sendEmailVerification(customerAuthRealm, account, origin)
    .catch((err: unknown) => {
      logger.warn({ err, customerId: account.id }, 'Verification email failed after sign-up');
    });

  return login(
    { email: body.email, password: body.password, device_info: body.device_info },
    origin,
  );
}

export async function getMe(customerId: number): Promise<WireCustomer> {
  const row = await customersRepository.findById(customerId);
  if (!row) throw new NotFoundError('Customer not found');
  return toWireCustomer(row);
}

export async function updateMe(
  customerId: number,
  body: UpdateCustomerProfileBody,
  origin?: authService.RequestOrigin,
): Promise<WireCustomer> {
  await assertPreferableBranch(body.preferred_branch_id);

  const row = await customersRepository.update(customerId, {
    ...(body.first_name !== undefined ? { first_name: body.first_name } : {}),
    ...(body.last_name !== undefined ? { last_name: body.last_name } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.preferred_branch_id !== undefined
      ? { preferred_branch_id: body.preferred_branch_id }
      : {}),
  });
  if (!row) throw new NotFoundError('Customer not found');

  // The customer's own edits belong in their activity trail too — support reads
  // it to answer "did they change their number before this?". Field NAMES only,
  // never values: the log is not a second copy of personal data.
  await customersRepository.logActivity({
    customerId,
    action: 'customer.profile_updated',
    details: { fields: Object.keys(body) },
    ipAddress: origin?.ipAddress ?? null,
    deviceInfo: origin?.deviceInfo ?? null,
  });
  return toWireCustomer(row);
}

/**
 * The customer erases their own account.
 *
 * Asks for the password again: an unlocked phone left on a table must not be
 * enough to destroy an account. Sessions, verification codes and the email claim
 * go with the row; the activity trail survives with `customer_id` nulled and the
 * address kept, so "someone signed in as X" stays findable after X is gone.
 *
 * ⚠️ When orders exist this must NOT hard-delete a customer who has any — the
 * order history has to keep resolving to a real record. The exit for those is
 * anonymisation (blank the personal columns, keep the row). This is the place to
 * add that branch; today nothing references a customer, so deletion is complete.
 */
export async function deleteSelf(
  customerId: number,
  password: string,
  origin: authService.RequestOrigin,
): Promise<void> {
  const account = await customerAccountStore.findById(customerId);
  if (!account) throw new NotFoundError('Customer not found');

  // 422, not 401: the request IS authenticated, and 401 makes every client sign
  // the user out — a mistyped password must not end the session.
  if (!(await verifyPassword(password, account.passwordHash))) {
    throw new BusinessError(422, 'Your current password is incorrect', 'current_password_wrong');
  }

  await customersRepository.logActivity({
    customerId,
    action: 'customer.self_deleted',
    details: { email: account.email },
    ipAddress: origin.ipAddress,
    deviceInfo: origin.deviceInfo,
  });
  await customersRepository.remove(customerId);
}

// ── Admin side ────────────────────────────────────────────────────────────────

export async function listCustomers(
  params: PaginationParams,
  filter: CustomersFilterQuery,
  canSeeContact: boolean,
): Promise<Paginated<WireCustomer>> {
  const { rows, total } = await customersRepository.findMany(params, filter, canSeeContact);
  return paginated(
    rows.map((r) => applyContactPolicy(toWireCustomer(r), canSeeContact)),
    total,
    params,
  );
}

export async function getCustomerById(id: number): Promise<WireCustomer> {
  const row = await customersRepository.findById(id);
  if (!row) throw new NotFoundError('Customer not found');
  return toWireCustomer(row);
}

/**
 * Moves a customer to [next], recording who did it.
 *
 * Takes effect **on the customer's very next request**, not when their token
 * expires: the auth middleware re-asks `canSignIn` on every call and drops the
 * session of anyone refused (core/middleware/auth.ts). So suspending needs no
 * session sweep here — and a sweep would only be a second, weaker way to say it.
 *
 * Re-applying the current status answers with the row and writes nothing: a
 * double-click must not fill the audit log with entries that changed nothing.
 */
/** Fire-and-forget (see `notify`): the decision is already made and recorded. */
function tellCustomer(
  row: CustomerRow,
  event: (typeof NOTIFICATION)[keyof typeof NOTIFICATION],
  reason?: string | null,
): void {
  notify({
    realm: 'customer',
    accountId: row.id,
    email: row.email,
    lang: row.preferred_language,
    event,
    reason,
  });
}

async function setStatus(
  actor: RequestActorContext,
  id: number,
  next: CustomerRow['status'],
  action: string,
): Promise<WireCustomer> {
  const before = await customersRepository.findById(id);
  if (!before) throw new NotFoundError('Customer not found');
  // Writing to a retired record is refused, exactly as for users and branches:
  // `reactivate` on an archived one would produce an active customer nobody
  // can see in any list.
  assertNotArchived(before);
  if (before.status === next) return toWireCustomer(before);

  const row = await customersRepository.update(id, { status: next });
  if (!row) throw new NotFoundError('Customer not found');

  await auditService.record(
    actor,
    action,
    target.customer(id),
    { status: before.status },
    { status: row.status },
  );
  // Suspension and reactivation are worth telling; `disabled` is permanent
  // offboarding — the person learns it by being unable to sign in, and a push
  // "you are disabled" adds nothing they can act on.
  if (next === 'suspended') tellCustomer(row, NOTIFICATION.accountSuspended);
  if (next === 'active') tellCustomer(row, NOTIFICATION.accountReactivated);
  return toWireCustomer(row);
}

export const suspendCustomer = (actor: RequestActorContext, id: number): Promise<WireCustomer> =>
  setStatus(actor, id, 'suspended', AUDIT.customerSuspend);

export const disableCustomer = (actor: RequestActorContext, id: number): Promise<WireCustomer> =>
  setStatus(actor, id, 'disabled', AUDIT.customerDisable);

export const reactivateCustomer = (actor: RequestActorContext, id: number): Promise<WireCustomer> =>
  setStatus(actor, id, 'active', AUDIT.customerReactivate);

// ── Wholesale ─────────────────────────────────────────────────────────────────

/**
 * A verified customer asks to be priced as wholesale.
 *
 * `customer_type` does NOT change here — only `wholesale_status` moves to
 * `pending`. Until an admin approves, the customer keeps buying at retail (a
 * request must never punish the person who files it — customer_accounts.md §4).
 * A rejected customer may ask again; an open or approved one may not.
 *
 * The route that calls this carries `requireVerifiedCustomer`: a wholesale
 * account is a commercial relationship, and it must not start from an address
 * nobody has proven.
 */
export async function requestWholesale(
  customerId: number,
  origin: authService.RequestOrigin,
): Promise<WireCustomer> {
  const before = await customersRepository.findById(customerId);
  if (!before) throw new NotFoundError('Customer not found');
  if (before.customer_type === 'wholesale' || before.wholesale_status === 'pending') {
    throw new BusinessError(
      409,
      'A wholesale request is already open or approved',
      'wholesale_request_not_allowed',
    );
  }

  const row = await customersRepository.update(customerId, {
    wholesale_status: 'pending',
    wholesale_requested_at: new Date(),
    wholesale_decided_at: null,
    wholesale_decided_by_user_id: null,
    wholesale_rejection_reason: null,
  });
  if (!row) throw new NotFoundError('Customer not found');

  await customersRepository.logActivity({
    customerId,
    action: 'customer.wholesale_requested',
    ipAddress: origin.ipAddress,
    deviceInfo: origin.deviceInfo,
  });
  return toWireCustomer(row);
}

/** Approve makes the customer wholesale; reject records why. Only a `pending` request can be decided — a second decision would rewrite history. */
export async function decideWholesale(
  actor: RequestActorContext,
  id: number,
  body: DecideWholesaleBody,
): Promise<WireCustomer> {
  const before = await customersRepository.findById(id);
  if (!before) throw new NotFoundError('Customer not found');
  assertNotArchived(before);
  if (before.wholesale_status !== 'pending') {
    throw new BusinessError(409, 'No wholesale request is pending', 'wholesale_not_pending');
  }

  const approve = body.decision === 'approve';
  const row = await customersRepository.update(id, {
    customer_type: approve ? 'wholesale' : 'retail',
    wholesale_status: approve ? 'approved' : 'rejected',
    wholesale_decided_at: new Date(),
    wholesale_decided_by_user_id: actor.userId,
    wholesale_rejection_reason: approve ? null : (body.reason ?? null),
  });
  if (!row) throw new NotFoundError('Customer not found');

  await auditService.record(
    actor,
    AUDIT.customerWholesaleDecide,
    target.customer(id),
    { customer_type: before.customer_type, wholesale_status: before.wholesale_status },
    {
      customer_type: row.customer_type,
      wholesale_status: row.wholesale_status,
      ...(approve ? {} : { reason: row.wholesale_rejection_reason }),
    },
  );
  tellCustomer(
    row,
    approve ? NOTIFICATION.wholesaleApproved : NOTIFICATION.wholesaleRejected,
    row.wholesale_rejection_reason,
  );
  return toWireCustomer(row);
}

/**
 * Withdraws an approved wholesale account — back to retail, no pending request.
 *
 * The admin could approve but never undo, so a wrong approval (or a customer who
 * stopped qualifying) could only be fixed in the database. The reason is
 * mandatory and lands in the audit log: taking a price away from someone who
 * relies on it is the decision most likely to be asked about later.
 */
export async function revokeWholesale(
  actor: RequestActorContext,
  id: number,
  body: RevokeWholesaleBody,
): Promise<WireCustomer> {
  const before = await customersRepository.findById(id);
  if (!before) throw new NotFoundError('Customer not found');
  assertNotArchived(before);
  if (before.customer_type !== 'wholesale') {
    throw new BusinessError(409, 'This account is not wholesale', 'wholesale_not_approved');
  }

  const row = await customersRepository.update(id, {
    customer_type: 'retail',
    wholesale_status: null,
    wholesale_requested_at: null,
    wholesale_decided_at: null,
    wholesale_decided_by_user_id: null,
    wholesale_rejection_reason: null,
  });
  if (!row) throw new NotFoundError('Customer not found');

  await auditService.record(
    actor,
    AUDIT.customerWholesaleRevoke,
    target.customer(id),
    { customer_type: before.customer_type, wholesale_status: before.wholesale_status },
    { customer_type: row.customer_type, wholesale_status: null, reason: body.reason },
  );
  tellCustomer(row, NOTIFICATION.wholesaleRevoked, body.reason);
  return toWireCustomer(row);
}

/**
 * The customer moves their account to another mailbox.
 *
 * What makes this safe rather than a takeover door:
 * - **the password is asked again** (a stolen unlocked session alone is not
 *   enough to hand the account to someone else's inbox);
 * - the new address is **unverified** — purchasing stops until the code sent
 *   THERE is entered, so a typo or a stranger's address cannot buy;
 * - **every other session is ended**: whoever else holds a token loses it,
 *   which is the point of changing an address after suspecting a compromise;
 * - the uniqueness claim moves in one transaction (`account_emails`), so the
 *   address cannot end up owned by two accounts, in either realm.
 */
export async function changeEmail(
  customerId: number,
  currentSessionId: number | null,
  body: ChangeEmailBody,
  origin: authService.RequestOrigin,
): Promise<WireCustomer> {
  const account = await customerAccountStore.findById(customerId);
  if (!account) throw new NotFoundError('Customer not found');

  // Only an address nobody has proven yet may be corrected. A VERIFIED address
  // is the account's identity — it is where password resets go — so moving it is
  // a takeover door with no legitimate everyday use; that person contacts
  // support. The one real need is the typo at sign-up (`gmial.com`), where the
  // customer is stuck at the code screen and would otherwise have to delete the
  // account and start again.
  if (account.emailVerifiedAt !== null) {
    throw new BusinessError(
      409,
      'A verified email address cannot be changed here',
      'email_change_not_allowed',
    );
  }
  if (!(await verifyPassword(body.password, account.passwordHash))) {
    throw new BusinessError(422, 'Your current password is incorrect', 'current_password_wrong');
  }
  if (body.email === account.email) {
    throw new BusinessError(422, 'That is already your email address', 'email_unchanged');
  }

  let row;
  try {
    row = await customersRepository.update(customerId, {
      email: body.email,
      email_verified_at: null,
    });
  } catch (err) {
    // The unique index (either table) is the only thing that holds under a race.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      throw new BusinessError(409, 'An account with this email already exists', 'email_taken');
    }
    throw err;
  }
  if (!row) throw new NotFoundError('Customer not found');

  await sessionService.revokeAllForUser(
    customerAuthRealm,
    customerId,
    currentSessionId ?? undefined,
  );
  await customersRepository.logActivity({
    customerId,
    action: 'customer.email_changed',
    // Masked: the log must not become a second copy of personal data.
    details: { from: maskEmail(account.email), to: maskEmail(body.email) },
    ipAddress: origin.ipAddress,
    deviceInfo: origin.deviceInfo,
  });

  // Background, like sign-up: the code is stored before it is mailed, a failure
  // costs a "resend" tap and is logged for the operator.
  const fresh = await customerAccountStore.findById(customerId);
  if (fresh) {
    void authService
      .sendEmailVerification(customerAuthRealm, fresh, origin, { ignoreCooldown: true })
      .catch((err: unknown) =>
        logger.warn({ err, customerId }, 'Verification email failed after email change'),
      );
  }
  return toWireCustomer(row);
}

// ── Retiring an account ───────────────────────────────────────────────────────

function assertNotArchived(row: CustomerRow): void {
  if (row.archived_at !== null) {
    throw new BusinessError(409, 'This customer is archived', 'customer_archived');
  }
}

/**
 * Retires the account from every working list without destroying it.
 *
 * Forces `disabled` — same reason as users: an archived account that could
 * still sign in would be invisible AND active, the worst combination. The row
 * stays, so once orders exist their history keeps resolving to a real person.
 * The email stays reserved for the same reason: freeing it would let a stranger
 * take an address whose past belongs to someone else.
 */
export async function archiveCustomer(
  actor: RequestActorContext,
  id: number,
): Promise<WireCustomer> {
  const before = await customersRepository.findById(id);
  if (!before) throw new NotFoundError('Customer not found');
  if (before.archived_at !== null) return toWireCustomer(before);

  const row = await customersRepository.update(id, { archived_at: new Date(), status: 'disabled' });
  if (!row) throw new NotFoundError('Customer not found');
  await auditService.record(
    actor,
    AUDIT.customerArchive,
    target.customer(id),
    { status: before.status, archived: false },
    { status: row.status, archived: true },
  );
  return toWireCustomer(row);
}

/** Back on the working list — but still `disabled`: coming back into view is not permission to sign in; reactivating is a separate, deliberate step. */
export async function unarchiveCustomer(
  actor: RequestActorContext,
  id: number,
): Promise<WireCustomer> {
  const before = await customersRepository.findById(id);
  if (!before) throw new NotFoundError('Customer not found');
  if (before.archived_at === null) {
    throw new BusinessError(409, 'This customer is not archived', 'customer_not_archived');
  }

  const row = await customersRepository.update(id, { archived_at: null });
  if (!row) throw new NotFoundError('Customer not found');
  await auditService.record(
    actor,
    AUDIT.customerUnarchive,
    target.customer(id),
    { archived: true },
    { archived: false },
  );
  return toWireCustomer(row);
}

/**
 * Permanent removal — disabled accounts only.
 *
 * Requiring `disabled` first makes deletion a second, deliberate step after
 * stopping the account, never the first thing a mis-tap can do. When orders
 * exist this must also refuse an account that has any (archive is the exit for
 * those) — the check belongs here, beside this comment, and is the one place to
 * extend.
 */
export async function deleteCustomer(actor: RequestActorContext, id: number): Promise<void> {
  const before = await customersRepository.findById(id);
  if (!before) throw new NotFoundError('Customer not found');
  if (before.status !== 'disabled') {
    throw new BusinessError(
      409,
      'Only a disabled customer can be deleted',
      'customer_delete_requires_disabled',
    );
  }

  await customersRepository.remove(id);
  // The snapshot is what survives: the row is gone, and "who was customer:12?"
  // must still have an answer when someone asks why an address is free again.
  await auditService.record(
    actor,
    AUDIT.customerDelete,
    target.customer(id),
    { email: before.email, full_name: `${before.first_name} ${before.last_name}`.trim() },
    null,
  );
}

/**
 * The origin to use when mail is sent TO a customer BY someone else: same
 * request facts, but the language the customer reads. Falls back to the
 * request's when the customer has none stored yet.
 */
async function inCustomerLanguage(
  customerId: number,
  origin: authService.RequestOrigin,
): Promise<authService.RequestOrigin> {
  const row = await customersRepository.findById(customerId);
  const stored = row?.preferred_language;
  return stored === 'ar' || stored === 'en' ? { ...origin, lang: stored } : origin;
}

// ── Support actions: the admin triggers, the customer receives ────────────────

/**
 * Sends the customer a fresh verification code.
 *
 * The admin never SEES a code and never sets a password — both are mailed to
 * the customer's own address, which is the only thing that proves it is them.
 * Refusals are honest here (unlike the public reset flow): the caller is a
 * signed-in employee, so "cooldown" reveals nothing an outsider could use.
 */
export async function resendVerification(
  actor: RequestActorContext,
  id: number,
  origin: authService.RequestOrigin,
): Promise<void> {
  const account = await customerAccountStore.findById(id);
  if (!account) throw new NotFoundError('Customer not found');
  if (account.emailVerifiedAt !== null) {
    throw new BusinessError(
      409,
      'This email address is already confirmed',
      'verification_already_verified',
    );
  }

  const result = await authService.sendEmailVerification(
    customerAuthRealm,
    account,
    await inCustomerLanguage(id, origin),
  );
  if (!result.sent && result.retryAfterSeconds !== undefined) {
    throw new BusinessError(
      429,
      'A code was just sent — please wait',
      'verification_resend_cooldown',
    );
  }
  if (!result.sent && result.deliveryFailure !== undefined) {
    throw new BusinessError(
      502,
      'We could not send the email just now',
      'verification_send_failed',
    );
  }
  await auditService.record(
    actor,
    AUDIT.customerVerificationResend,
    target.customer(id),
    null,
    null,
  );
}

/** Mails a reset code to the customer. Same rule as above — the admin cannot read it. */
export async function sendPasswordReset(
  actor: RequestActorContext,
  id: number,
  origin: authService.RequestOrigin,
): Promise<void> {
  const account = await customerAccountStore.findById(id);
  if (!account) throw new NotFoundError('Customer not found');

  await authService.requestPasswordReset(
    customerAuthRealm,
    account.email,
    await inCustomerLanguage(id, origin),
  );
  await auditService.record(
    actor,
    AUDIT.customerPasswordResetSend,
    target.customer(id),
    null,
    null,
  );
}

export async function listActivity(
  id: number,
  params: PaginationParams,
): Promise<Paginated<WireCustomerActivity>> {
  const exists = await customersRepository.findById(id);
  if (!exists) throw new NotFoundError('Customer not found');
  const { rows, total } = await customersRepository.findActivity(id, params);
  return paginated(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      details: parseDetails(r.details),
      ip_address: r.ip_address,
      device_info: r.device_info,
      created_at: r.created_at.toISOString(),
    })),
    total,
    params,
  );
}

/** Stored as text; a row that is not JSON reads as absent rather than failing the whole page. */
function parseDetails(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
