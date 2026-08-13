/**
 * **Every verification email goes to the address that registered.**
 *
 * ## Why this test exists
 *
 * On 2026-08-12 no verification mail reached any address except one. The
 * application was correct — the provider was refusing every message whose
 * recipient was not the account owner — but nothing in the system could say so:
 * `EmailSender.send` returned `void`, registration answered `201`, and the audit
 * log recorded `auth.email.verification_sent`. Three green signals over a
 * message that had been rejected.
 *
 * The investigation that followed had to re-derive, by reading, that the
 * recipient is never anything but `user.email`. This test makes that a fact the
 * suite asserts instead of a fact someone re-establishes.
 *
 * ## Why several users in ONE run, and not one user per run
 *
 * A single registration cannot distinguish "the recipient is the user's address"
 * from "the recipient is a constant that happens to equal the user's address" —
 * with one sample the two are identical. Four users on four different domains
 * are registered against the same live sender, and the assertions are about the
 * *set*: every message matched to its own account, no address receiving another
 * account's code, no message addressed to anything nobody registered.
 *
 * ## Why it drives real HTTP through the real app
 *
 * The claim is about a value surviving a journey — request body → zod → column →
 * `AuthAccount` → template → envelope. Calling `sendEmailVerification` directly
 * would skip the two layers most able to substitute something (validation and
 * the account store) and prove only the last hop.
 *
 * ## What it needs
 *
 *   - Postgres, migrated and seeded  (`npm run db:setup`)
 *   - `EMAIL_VERIFICATION_MODE` not `off`
 *   - NO mail configuration at all — the transport is replaced in-process.
 *
 * Run: `npm run test:mail`
 */
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { pool } from '../src/core/db/client.js';
import { setEmailSender } from '../src/core/auth/ports/email-sender.js';
import type {
  EmailDeliveryResult,
  EmailMessage,
  EmailSender,
} from '../src/core/auth/ports/email-sender.js';
import { isEmailVerificationEnabled } from '../src/core/auth/config/auth-config.js';

let pass = 0;
let fail = 0;
const chk = (name: string, ok: boolean, detail = ''): void => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  [${detail}]` : ''}`);
};

/**
 * The transport, replaced by a notebook.
 *
 * This is the same seam `AuthComposition.emailSender` offers and the same one a
 * future HTTP provider would occupy — the test needs no special support in the
 * production code, which is the evidence that the abstraction is real rather
 * than declared.
 */
class CapturingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    this.sent.push(message);
    return { ok: true, messageId: `captured-${this.sent.length}` };
  }
}

/**
 * Four addresses, four domains, one run.
 *
 * The local parts are deliberately unequal in shape — length, dots, digits — so
 * a truncation or a normalisation that mangles one would not mangle all four
 * identically and hide itself.
 */
const CASES = [
  { local: 'userA', domain: 'gmail.com', first: 'User', last: 'Alpha', phone: '0931100001' },
  { local: 'userB', domain: 'company.com', first: 'User', last: 'Bravo', phone: '0931100002' },
  { local: 'user.c.charlie', domain: 'outlook.com', first: 'User', last: 'Charlie', phone: '0931100003' },
  { local: 'user-d99', domain: 'sub.example.co.uk', first: 'User', last: 'Delta', phone: '0931100004' },
];

const capturing = new CapturingEmailSender();
const app = buildApp();
// AFTER buildApp: `configureAuth` installs the configured transport, and this
// replaces it. Nothing reaches a network for the rest of the run — the test is
// about the address on the envelope, not about anyone's SMTP server.
setEmailSender(capturing);

const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

interface ApiResponse {
  status: number;
  json: {
    data?: { user?: { id?: number; email?: string }; items?: unknown[] } | unknown[];
    message?: string;
  } | null;
}

async function call(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept-language': 'en' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: ApiResponse['json'] = null;
  try {
    json = (await res.json()) as ApiResponse['json'];
  } catch {
    /* a 204 or a non-JSON error page — `status` still carries the verdict */
  }
  return { status: res.status, json };
}

const createdUserIds: number[] = [];
// A run-unique tag: two runs an hour apart must not collide on the unique email
// index, and a half-finished earlier run must not make this one look broken.
const runTag = `${Date.now()}`;

/** What the client sends — mixed case on purpose, see `deliveredTo`. */
const addressFor = (c: (typeof CASES)[number]): string => `${c.local}+qa${runTag}@${c.domain}`;

/**
 * What the address becomes, and therefore what must appear on the envelope.
 *
 * `registerStaffBodySchema` declares `.trim().toLowerCase()`, so `userA@…` is
 * stored — and mailed — as `usera@…`. That is deliberate and load-bearing: the
 * unique index on `users.email` is case-sensitive, so without it `userA@x.com`
 * and `usera@x.com` would be two accounts for one mailbox.
 *
 * Asserted through this function rather than against the raw input because the
 * two are genuinely different claims. "The recipient is whatever was typed" is
 * false here and should be. "The recipient is this account's address, and
 * lower-casing is the ONLY thing that happened to it" is the true one, and the
 * mixed-case local parts in `CASES` are what give it teeth — an implementation
 * that dropped, truncated or substituted the address would fail this even
 * though it also lower-cases.
 */
const deliveredTo = (c: (typeof CASES)[number]): string => addressFor(c).toLowerCase();

try {
  chk(
    'email verification is enabled (EMAIL_VERIFICATION_MODE ≠ off)',
    isEmailVerificationEnabled(),
    'with `off` no verification mail is sent at all and this test proves nothing',
  );

  const rolesRes = await call('GET', '/roles/self-registerable');
  const roles = (rolesRes.json?.data ?? []) as { id?: number }[];
  const roleId = Array.isArray(roles) ? roles[0]?.id : undefined;
  chk('a self-registerable role exists to request', typeof roleId === 'number', `role ${String(roleId)}`);

  if (typeof roleId !== 'number' || !isEmailVerificationEnabled()) {
    throw new Error('preconditions not met — see the failures above (run `npm run db:setup`?)');
  }

  // ── Register every case ───────────────────────────────────────────────────
  for (const c of CASES) {
    const email = addressFor(c);
    const res = await call('POST', '/users/register', {
      first_name: c.first,
      last_name: c.last,
      email,
      phone: c.phone,
      password: 'Testpass123',
      requested_role_id: roleId,
    });

    // 429 here is the per-IP registration limiter (5/hour), not a mail problem —
    // named explicitly because "registration rejected" would otherwise read as a
    // failure of the thing under test.
    chk(
      `registered ${c.domain}`,
      res.status === 201,
      res.status === 429 ? 'HTTP 429 — register rate limit, re-run in an hour' : `HTTP ${res.status}`,
    );

    const data = res.json?.data as { user?: { id?: number } } | undefined;
    const id = data?.user?.id;
    if (typeof id === 'number') createdUserIds.push(id);
  }

  // ── The assertions this file exists for ───────────────────────────────────
  const expected = CASES.map(deliveredTo);
  const verification = capturing.sent.filter((m) => m.kind === 'email_verification');

  chk(
    'one verification email per registration — no more, no fewer',
    verification.length === CASES.length,
    `${verification.length} captured for ${CASES.length} registrations`,
  );

  // Matched pairwise, in order: registration N's mail is registration N's mail.
  // A set comparison would pass if the four codes were dealt to the four
  // addresses in the wrong order, which is the cross-user leak this is for.
  for (const [i, want] of expected.entries()) {
    const got = verification[i]?.to;
    chk(`recipient #${i + 1} is the address that registered`, got === want, `to=${String(got)}`);
  }

  // Stated separately from the equality above so a future change to
  // normalisation reads as what it is. If someone adds plus-tag stripping or
  // domain rewriting, the checks above would still pass once `deliveredTo` was
  // updated to match — this one says the address is the SAME address, compared
  // without regard to the one transformation that is allowed.
  chk(
    'lower-casing is the only transformation applied to the address',
    verification.every(
      (m, i) => m.to.toLowerCase() === addressFor(CASES[i]!).toLowerCase(),
    ),
  );

  const recipients = verification.map((m) => m.to);

  chk(
    'no address received more than one code',
    new Set(recipients).size === recipients.length,
    recipients.join(', '),
  );

  // The failure mode this catches directly: a fixed TEST_EMAIL / MAIL_TO /
  // dev-redirect would make every `to` identical, and with N>1 that is visible
  // as a collapsed set even before the pairwise check above.
  chk(
    'recipients are N distinct addresses, not one constant',
    new Set(recipients).size === CASES.length,
    `${new Set(recipients).size} distinct`,
  );

  chk(
    'every recipient is an address this run registered — nothing else was mailed',
    recipients.every((to) => expected.includes(to)),
    recipients.filter((to) => !expected.includes(to)).join(', ') || 'none stray',
  );

  chk(
    'each message carries a code, and never another account’s',
    verification.every((m, i) => m.to === expected[i] && m.text.length > 0),
  );

  // Codes are per-message secrets; two accounts sharing one would mean the
  // template or the issuer is keeping state it should not.
  const codes = verification.map((m) => /\n {4}([A-Z0-9]+)\n/.exec(m.text)?.[1] ?? '');
  chk(
    'every message carries its own distinct code',
    codes.every((c) => c.length > 0) && new Set(codes).size === codes.length,
    `${new Set(codes).size} distinct codes`,
  );
} finally {
  // ── Cleanup ───────────────────────────────────────────────────────────────
  // audit_log_entries.user_id is ON DELETE RESTRICT, so its rows go first;
  // sessions and verification_tokens cascade with the user.
  if (createdUserIds.length > 0) {
    try {
      await pool.query('DELETE FROM audit_log_entries WHERE user_id = ANY($1::int[])', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
      console.log(`🧹 removed ${createdUserIds.length} test users`);
    } catch (err) {
      // Reported, not swallowed: leftovers hold the unique email index and would
      // make the NEXT run fail for a reason that has nothing to do with mail.
      console.error('⚠️  cleanup failed — remove these users manually:', createdUserIds, err);
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
