# Mail — how a code reaches its owner

> Two flows send mail: **email verification** and **password reset**. Both go
> through one port and one adapter. This file is the whole story: what is
> configured, what is deliberately absent, and what changes on the way to
> production.

---

## 1. The rule that governs everything else

**There is no recipient configuration.** Not in `env`, not in code, not in a
dev-only override.

Every message is addressed to the account it concerns, and the address travels
untouched from the request body to the SMTP envelope:

```
req.body.email                             POST /users/register
  → zod .trim().toLowerCase().email()      identity/dtos/users.dto.ts
  → users.email (row)                      identity/repositories/account-store.impl.ts
  → account.email
  → buildVerifyEmail(account.email, …)     core/auth/services/auth.service.ts
  → EmailMessage.to                        core/auth/emails/auth-emails.ts
  → sendMail({ to })                       core/auth/adapters/smtp-email-sender.ts
```

There is no branch anywhere on *which* address it is. `tests/email-recipient.test.ts`
asserts this end-to-end for four users of four different domains registered in
one run, and fails if any message is addressed to anything but its own account.

### Why there is no `MAIL_DEV_REDIRECT_TO`

A "send all development mail to one address" switch is the obvious convenience
and it is deliberately not here. It makes the recipient path untestable exactly
where it is most likely to be wrong: mail keeps arriving, so nothing looks
broken, and the first time a real second user registers is the first time anyone
finds out. A sandbox mailbox (below) gives the same convenience without lying
about who the message was for.

---

## 2. The three transports

Selected by `MAIL_TRANSPORT` (`auto` | `smtp` | `log`), resolved in
[`core/auth/composition.ts`](../src/core/auth/composition.ts).
`auto` — the default — picks SMTP when `SMTP_HOST` is set, and the log adapter
otherwise.

| | `LogEmailSender` | SMTP → **Sandbox** | SMTP → **Sending** |
|---|---|---|---|
| Configuration | none | inbox credentials | verified domain + credentials |
| Where mail goes | the server log | Mailtrap's web inbox | the real mailbox |
| Recipients accepted | any | **any** | governed by the sender domain |
| Use | zero-setup local work, e2e tests | **development, current default** | staging & production |

### `log` — no mail server at all

Writes subject, recipient and **body** (so, the code) to the server log at
`warn`. Usable on a laptop with nothing installed;
`tests/auth-verification.e2e.mjs` reads codes out of these lines.

In production it refuses: it logs an error naming the misconfiguration,
withholds the body, and returns `{ ok: false, errorCode: 'no_transport' }`. A
code in a log file is readable by everyone with log access, which is always a
larger group than "the account owner".

### Sandbox — the development default

```
SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=2525
SMTP_SECURE=false
SMTP_USER=…      # Mailtrap → Inboxes → your inbox → Integrations → Nodemailer
SMTP_PASS=…      # same screen
MAIL_FROM=Qirtas <no-reply@qirtas.test>
```

Nothing leaves Mailtrap; every message lands in its web inbox regardless of who
it was addressed to. That last property is why this is the development default:
`userA@gmail.com`, `userB@company.com` and `userC@outlook.com` can all be
registered and all three messages are visible and readable.

`MAIL_FROM` needs no verification here — the sandbox delivers nowhere, so no
receiving server ever evaluates the sender.

### Sending — staging and production

```
SMTP_HOST=live.smtp.mailtrap.io
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=…
SMTP_PASS=…
MAIL_FROM=Qirtas <no-reply@your-real-domain.tld>
```

Real delivery to real mailboxes. **The sender domain is the constraint**, and it
is where this configuration failed before (see §5).

---

## 3. Moving to production

1. **Own a real domain.** Not a placeholder, not `.test`, not `.local` — it must
   resolve and accept DNS records.
2. **Add it as a Sending Domain** with the provider, and publish the DNS records
   it asks for: SPF, DKIM, and normally DMARC. Verification is not a formality —
   an unverified domain cannot send, and receiving servers junk mail whose SPF
   and DKIM do not line up with the From address.
3. **Point `MAIL_FROM` at that domain** — `Qirtas <no-reply@your-domain.tld>`.
   A From address on a domain you have not verified is refused by the provider,
   not merely disliked.
4. **Set `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS`** to the Sending credentials.
   Keep `SMTP_PORT=587` with `SMTP_SECURE=false` (STARTTLS) or `465` with
   `SMTP_SECURE=true` (implicit TLS) — both are correct, they are different
   modes and not different levels of protection.
5. **Confirm at boot**: the log line reads `Mail transport: SMTP`. If it reads
   `Mail transport: log`, `SMTP_HOST` did not reach the process.
6. **Confirm one real send**: register a throwaway account and look for
   `Email accepted by the mail server.` with a `messageId`.

**Nothing in step 1–6 touches code.** Switching from Mailtrap to Gmail, SES over
SMTP, or an organisation's own relay is the same six steps with different values.

---

## 4. Changing provider entirely

The abstraction that makes this cheap is one interface:

```ts
// core/auth/ports/email-sender.ts
interface EmailSender {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}
```

`core/auth/services/auth.service.ts` calls `emailSender().send(...)` and knows
nothing else — no host, no port, no provider name, no SMTP vocabulary. The one
function in the codebase that understands SMTP errors is `classify()` inside the
SMTP adapter.

**Any SMTP provider** — Mailtrap, Gmail, SES, Postmark, an internal relay — is
environment variables only, no code.

**An HTTP mail API** (SendGrid, Resend, Postmark's REST API) is:

1. a new file beside `smtp-email-sender.ts` implementing `EmailSender`,
2. one branch in `selectEmailSender()` in `composition.ts`.

Nothing in `auth.service.ts`, the controllers, the routes or the templates
changes, because none of them ever named a provider.

**Tests** override the transport without touching configuration at all:
`configureAuth({ …, emailSender })`, or `setEmailSender(…)` afterwards. That is
how `tests/email-recipient.test.ts` captures messages instead of sending them.

---

## 5. The failure this configuration is written against

*(2026-08-12 — recorded because the symptom pointed away from the cause.)*

`MAIL_FROM` was `Qirtas <hello@demomailtrap.co>`, the provider's pre-verified
**demo** domain, against Live Sending. That domain is allowed to send **only to
the address that owns the provider account**.

So: registrations using the owner's address were delivered and visible in the
provider's log. Registrations using any other address were rejected during the
SMTP handshake, before the message was accepted — so they produced **no log
entry at the provider at all**. The natural reading of an empty log is "the
application never sent it", which sent the investigation into the application,
where nothing was wrong.

Two things made it survive:

- `send()` returned `void`, so the rejection could not travel anywhere. The
  request answered `201 Created`, `POST /auth/resend-verification` answered
  "code sent", and `auth.email.verification_sent` was written to the audit log —
  three independent confirmations of something that had not happened.
- There was **no success log line**, so the absence of an error was not evidence
  of anything.

Both are fixed: `send()` returns `EmailDeliveryResult`, the audit event is chosen
from it (`auth.email.verification_send_failed` on failure), and every send —
success or failure — logs.

---

## 6. What is logged

Every send emits exactly one line.

**Success** (`info`): `provider`, `host`, `kind`, `recipientDomain`, `messageId`.
**Failure** (`error`): the same, plus `errorCode` and the provider's own error.

```
Email accepted by the mail server.   provider=smtp kind=email_verification recipientDomain=gmail.com messageId=<…>
SMTP delivery failed …               provider=smtp kind=email_verification recipientDomain=gmail.com errorCode=rejected
```

**Recipient domain only** — never the full address. `gmail.com` answers "is
delivery to this provider broken?", which is the question a log is read for; the
local part adds a person's address to every backup and answers nothing. When one
account must be traced, the audit log has `user_id` on the matching event.

**Never logged**: the message body (it carries the code), the code itself, any
password or hash, any SMTP credential. The one exception is `LogEmailSender` in
development, which writes the body deliberately — that is its entire purpose,
and it is the reason it refuses to run in production.

`errorCode` is one of five diagnostic values, and **none is ever sent to a
client**:

| code | means | first thing to check |
|---|---|---|
| `no_transport` | nothing was configured | `SMTP_HOST` reached the process |
| `auth` | credentials refused | `SMTP_USER` / `SMTP_PASS` |
| `rejected` | envelope refused | `MAIL_FROM` domain verified? recipient permitted by the plan? |
| `connection` | provider unreachable | host, port, egress firewall |
| `unknown` | unclassified | read the attached error |

---

## 7. What a delivery failure does to the HTTP response

Deliberately different per endpoint, and the difference is a security decision,
not an inconsistency.

| endpoint | on delivery failure | why |
|---|---|---|
| `POST /users/register` | still **201** | the account exists and holds a session; it can resend. Failing here would delete a valid registration over a transient mail problem |
| `POST /auth/resend-verification` | **502** `verification_send_failed` | authenticated — the caller already proved they own the account, so "we could not send it" reveals nothing about anyone else. Answering "sent" would send them to wait for mail that was refused |
| `POST /auth/forgot-password` | **unchanged**, always the same answer | this endpoint must respond identically for a registered and an unregistered address, or it becomes a way to discover who has an account here. *Any* observable difference reopens that — including one caused by a mail failure. The operator learns from the audit event; the requester learns nothing |

The user-facing message never names the provider, the host, the error code or
the reason. Those live in the log and the audit row.

---

## 8. Required environment variables

| variable | required | meaning |
|---|---|---|
| `MAIL_TRANSPORT` | no (`auto`) | `auto` \| `smtp` \| `log` |
| `SMTP_HOST` | for SMTP | empty selects the log adapter under `auto` |
| `SMTP_PORT` | no (`587`) | 587 with STARTTLS, 465 with implicit TLS |
| `SMTP_SECURE` | no (`false`) | `true` = implicit TLS (465) |
| `SMTP_USER` | provider-dependent | omitted from the connection entirely when empty, because some internal relays reject a session that offers empty credentials |
| `SMTP_PASS` | with `SMTP_USER` | **secret** |
| `MAIL_FROM` | production | envelope From. Falls back to `SMTP_USER`. Must be on a verified domain for real sending |
| `EMAIL_VERIFICATION_MODE` | no (`off`) | `off` \| `optional` \| `required`. Qirtas runs `required` |

There is **no** recipient variable, and adding one would defeat §1.
