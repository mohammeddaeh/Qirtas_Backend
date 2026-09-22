/**
 * End-to-end: device registration and the notifications a decision triggers.
 *
 * Needs the log push transport (no FCM_SERVICE_ACCOUNT_PATH) and a server log to
 * read back what would have been delivered:
 *
 *   MAIL_TRANSPORT=log PORT=3100 npm run dev > srv.log 2>&1
 *   E2E_BASE=http://localhost:3100/api/v1 E2E_LOG=srv.log E2E_ADMIN_PASSWORD=… \
 *     node tests/notifications.e2e.mjs
 *
 * Every case that proves "a push went out" is paired with one proving "and none
 * went where it must not" — a sender that pushes to everything passes the first
 * kind alone.
 */
import { readFileSync } from 'node:fs';

const B = process.env.E2E_BASE ?? 'http://localhost:3100/api/v1';
const LOG = process.env.E2E_LOG ?? 'srv.log';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'super_admin@admin.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('Set E2E_ADMIN_PASSWORD (the seeded super admin password).');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const chk = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  [' + extra + ']' : ''}`);
};

async function call(method, path, body, token) {
  const r = await fetch(B + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept-language': 'en',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* non-JSON */
  }
  return { status: r.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * One entry per push that went to a token starting with [prefix]. pino-pretty
 * writes each push over several lines (to / title / body / data), so an entry is
 * the "to" line plus the three after it.
 */
async function logLines(prefix) {
  await sleep(600);
  const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const lines = readFileSync(LOG, 'utf8').replace(ansi, '').split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if (l.includes('to: "' + prefix)) out.push(lines.slice(i, i + 4).join(' '));
  });
  return out;
}
const pushesTo = async (prefix) => (await logLines(prefix)).length;

const stamp = Date.now();
const TOKEN_A = `AAAAAA01${'a'.repeat(40)}`;
const TOKEN_B = `BBBBBB02${'b'.repeat(40)}`;

let r = await call('POST', '/users/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
const admin = r.json?.data?.token;
chk('admin signs in', !!admin);

const roles = (await call('GET', '/roles?limit=100', null, admin)).json?.data?.items ?? [];
const role = roles.find((x) => x.name === 'شريك مالي');
const email = `notify.${stamp}@example.com`;
r = await call(
  'POST',
  '/users',
  { first_name: 'Nour', last_name: 'Tester', email, phone: '0933' + String(stamp).slice(-6), password: 'Passw0rd!x', role_id: role.id },
  admin,
);
const userId = r.json?.data?.id;
chk('test staff account created', r.status === 201 && userId, `${r.status}`);
r = await call('POST', '/users/login', { email, password: 'Passw0rd!x' });
const userToken = r.json?.data?.token;

// ── registration ─────────────────────────────────────────────────────────────
r = await call('POST', '/auth/push-token', { token: TOKEN_A, platform: 'android', language: 'en' });
chk('a guest cannot register a device → 401', r.status === 401, `${r.status}`);
r = await call('POST', '/auth/push-token', { token: 'short', platform: 'android' }, userToken);
chk('a malformed token is refused → 422', r.status === 422, `${r.status}`);
r = await call('POST', '/auth/push-token', { token: TOKEN_A, platform: 'windows' }, userToken);
chk('an unknown platform is refused → 422', r.status === 422, `${r.status}`);
r = await call('POST', '/auth/push-token', { token: TOKEN_A, platform: 'android', language: 'en' }, userToken);
chk('a signed-in account registers its device', r.status === 200, `${r.status}`);
r = await call('POST', '/auth/push-token', { token: TOKEN_A, platform: 'android', language: 'en' }, userToken);
chk('registering the same token again is idempotent', r.status === 200, `${r.status}`);

// ── a decision on the account pushes to its device, in the device language ───
r = await call('POST', `/users/${userId}/suspend`, null, admin);
chk('admin suspends the account', r.status === 200, `${r.status}`);
let lines = await logLines('AAAAAA01');
chk('the device got a push', lines.length >= 1, `${lines.length}`);
chk('…written in the device language (en)', lines.some((l) => l.includes('Your account is on hold')));
chk('…and never in the other one', !lines.some((l) => l.includes('عُلِّق')));

r = await call('POST', `/users/${userId}/reactivate`, null, admin);
lines = await logLines('AAAAAA01');
chk('reactivation pushes too', lines.some((l) => l.includes('Your account is active again')));
const afterReactivate = await pushesTo('AAAAAA01');

// ── removal is scoped to the owner ───────────────────────────────────────────
r = await call('POST', '/auth/push-token/remove', { token: TOKEN_A }, admin);
chk('removing someone else\'s token answers 200 but changes nothing', r.status === 200);
await call('POST', `/users/${userId}/suspend`, null, admin);
chk('…so the owner still receives pushes', (await pushesTo('AAAAAA01')) > afterReactivate);
await call('POST', `/users/${userId}/reactivate`, null, admin);

// sign-in again as the account may have been ended by the suspension
r = await call('POST', '/users/login', { email, password: 'Passw0rd!x' });
const userToken2 = r.json?.data?.token;
const beforeRemoval = await pushesTo('AAAAAA01');
r = await call('POST', '/auth/push-token/remove', { token: TOKEN_A }, userToken2);
chk('the owner removes its own token at sign-out', r.status === 200, `${r.status}`);
await call('POST', `/users/${userId}/suspend`, null, admin);
await sleep(400);
chk('…and no push goes to it afterwards', (await pushesTo('AAAAAA01')) === beforeRemoval);

// ── a device that changes hands moves with it ────────────────────────────────
await call('POST', `/users/${userId}/reactivate`, null, admin);
r = await call('POST', '/users/login', { email, password: 'Passw0rd!x' });
const userToken3 = r.json?.data?.token;
await call('POST', '/auth/push-token', { token: TOKEN_B, platform: 'ios', language: 'ar' }, userToken3);
await call('POST', '/auth/push-token', { token: TOKEN_B, platform: 'ios', language: 'ar' }, admin);
const beforeMove = await pushesTo('BBBBBB02');
await call('POST', `/users/${userId}/suspend`, null, admin);
await sleep(400);
chk('a token re-registered by another account no longer notifies the first one', (await pushesTo('BBBBBB02')) === beforeMove);

// cleanup: leave the account active and the admin device unregistered
await call('POST', `/users/${userId}/reactivate`, null, admin);
await call('POST', '/auth/push-token/remove', { token: TOKEN_B }, admin);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
