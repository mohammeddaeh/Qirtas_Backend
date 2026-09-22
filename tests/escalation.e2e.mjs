/**
 * End-to-end: privilege escalation and the account-kind split (2026-09-22).
 *
 * Every refusal here used to be a 200. A failure looks like success — the
 * request works and someone holds more than anyone decided — so each rule is
 * checked beside the case that must still pass.
 *
 * Covers: MFA enrollment closed by default · a level-less HR role cannot mint a
 * super admin (admin-created account, self-assignment, overrides) or strip the
 * root account · the assignable catalogue matches the guard · roles.edit cannot
 * add a key it lacks · unapproved staff are refused org data · a suspension
 * ends the session WITH its reason, once.
 *
 *   MAIL_TRANSPORT=log PORT=3100 npm run dev > srv.log 2>&1
 *   E2E_BASE=http://localhost:3100/api/v1 E2E_ADMIN_PASSWORD=… node tests/escalation.e2e.mjs
 *
 * Leaves behind (like the other suites): two roles and three accounts per run,
 * names stamped with the run time.
 */
const B = process.env.E2E_BASE ?? 'http://localhost:3100/api/v1';
let pass = 0, fail = 0;
const chk = (n, ok, x = '') => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${n}${x ? '  [' + x + ']' : ''}`); };
async function call(m, p, body, token) {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', 'Accept-language': 'en', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, key: j?.data?.message_key, json: j };
}
const admin = (await call('POST', '/users/login', { email: 'super_admin@admin.com', password: process.env.E2E_ADMIN_PASSWORD })).json?.data?.token;
chk('admin signs in', !!admin);

// MFA enrollment closed by default
let r = await call('POST', '/auth/mfa/setup', null, admin);
chk('MFA setup refused when not enabled', r.status === 403 && r.key === 'mfa_not_enabled', `${r.status} ${r.key}`);

const roles = (await call('GET', '/roles?limit=100', null, admin)).json?.data?.items ?? [];
const superRole = roles.find((x) => x.level === 0);
const stamp = Date.now();
// A level-less role that can create users and approve — the "HR" shape.
r = await call('POST', '/roles', { name: `HR e2e ${stamp}`, category: 'operational', permission_keys: ['users.create', 'users.view', 'users.access', 'roles.view'], force: true }, admin);
const hrRole = r.json?.data;
chk('admin creates a level-less HR role', r.status === 201 && hrRole?.level == null, `${r.status} ${r.key}`);
const hrEmail = `hr.${stamp}@example.com`;
r = await call('POST', '/users', { first_name: 'Hr', last_name: 'E2e', email: hrEmail, phone: '0933' + String(stamp).slice(-6), password: 'Passw0rd!x', role_id: hrRole.id }, admin);
const hrId = r.json?.data?.id;
const hr = (await call('POST', '/users/login', { email: hrEmail, password: 'Passw0rd!x' })).json?.data?.token;
chk('HR account signs in', !!hr);

r = await call('POST', '/users', { first_name: 'Evil', last_name: 'Root', email: `evil.${stamp}@example.com`, phone: '0944' + String(stamp).slice(-6), password: 'Passw0rd!x', role_id: superRole.id }, hr);
chk('HR cannot create a super admin account', r.status === 403 && r.key === 'role_above_actor_level', `${r.status} ${r.key}`);
r = await call('POST', `/users/${hrId}/role-assignments`, { role_id: superRole.id }, hr);
chk('HR cannot assign itself the super admin role', r.status === 403 && r.key === 'role_above_actor_level', `${r.status} ${r.key}`);
r = await call('PUT', `/users/${hrId}/overrides`, { overrides: [{ key: 'permissions.manage', effect: 'allow' }] }, hr);
chk('HR cannot allow itself a key it lacks', r.status === 403 && r.key === 'override_key_not_held', `${r.status} ${r.key}`);
const me = (await call('GET', '/users/me', null, admin)).json?.data; const rootId = me?.id ?? me?.user?.id;
r = await call('PUT', `/users/${rootId}/overrides`, { overrides: [{ key: 'users.access', effect: 'deny' }] }, hr);
chk('HR cannot strip the root account', r.status === 403, `${r.status} ${r.key}`);
r = await call('GET', '/roles?assignable=true&limit=100', null, hr);
const shown = r.json?.data?.items ?? [];
chk('assignable catalogue shows HR only level-less roles', shown.length > 0 && shown.every((x) => x.level == null), `${shown.length}`);

// roles.edit cannot add keys it lacks
r = await call('POST', '/roles', { name: `Editor e2e ${stamp}`, category: 'operational', permission_keys: ['roles.edit', 'roles.view'], force: true }, admin);
const edRole = r.json?.data;
const edEmail = `ed.${stamp}@example.com`;
await call('POST', '/users', { first_name: 'Ed', last_name: 'E2e', email: edEmail, phone: '0955' + String(stamp).slice(-6), password: 'Passw0rd!x', role_id: edRole.id }, admin);
const ed = (await call('POST', '/users/login', { email: edEmail, password: 'Passw0rd!x' })).json?.data?.token;
r = await call('PUT', `/roles/${edRole.id}/permissions`, { permission_keys: ['roles.edit', 'roles.view', 'users.delete'], force: true }, ed);
chk('roles.edit cannot add a key it lacks to its own role', r.status === 403 && r.key === 'role_key_not_held', `${r.status} ${r.key}`);
r = await call('PUT', `/roles/${edRole.id}/permissions`, { permission_keys: ['roles.edit', 'roles.view'], force: true }, ed);
chk('…but re-saving the keys it holds works', r.status === 200, `${r.status} ${r.key}`);

// unapproved staff
const pEmail = `pending.${stamp}@example.com`;
r = await call('POST', '/users/register', { first_name: 'Pen', last_name: 'Ding', email: pEmail, phone: '0966' + String(stamp).slice(-6), password: 'Passw0rd!x', requested_role_id: hrRole.id });
const pend = r.json?.data?.token;
r = await call('GET', '/branches', null, pend);
chk('unapproved staff cannot read /branches', r.status === 403 && r.key === 'account_not_approved', `${r.status} ${r.key}`);
r = await call('GET', '/branches', null, admin);
chk('…approved staff still can', r.status === 200, `${r.status}`);

// suspension reason reaches the client
await call('POST', `/users/${hrId}/suspend`, null, admin);
r = await call('GET', '/users/me', null, hr);
chk('suspended session ends with its reason', r.status === 401 && r.key === 'account_suspended', `${r.status} ${r.key}`);
r = await call('GET', '/users/me', null, hr);
chk('…said once: the next call is a plain 401', r.status === 401 && r.key !== 'account_suspended', `${r.status} ${r.key}`);
await call('POST', `/users/${hrId}/reactivate`, null, admin);

// ── a session ended ON PURPOSE says why (session_tombstones) ─────────────────
// Before, a revoked token was deleted like an expired one and answered a bare
// 401: the phone read "your session has ended" after someone changed the
// password — the one moment the owner should notice.
const loginHr = async () => (await call('POST', '/users/login', { email: hrEmail, password: 'Passw0rd!x' })).json?.data;
const phone = await loginHr();
const laptop = await loginHr();
r = await call('DELETE', `/auth/sessions/${phone.session_id}`, null, laptop.token);
chk('a session is revoked from another device', r.status === 200 || r.status === 204, `${r.status}`);
r = await call('GET', '/users/me', null, phone.token);
chk('the revoked device is told why', r.status === 401 && r.key === 'session_revoked' && r.json?.data?.revoke_reason === 'signed_out_elsewhere', `${r.status} ${r.key} ${r.json?.data?.revoke_reason}`);
r = await call('GET', '/users/me', null, phone.token);
chk('…and told again on retry — the reason is read, not consumed', r.status === 401 && r.key === 'session_revoked', `${r.status} ${r.key}`);
r = await call('POST', '/auth/refresh', null, phone.token);
chk('renewing a revoked token gives the same answer', r.status === 401 && r.key === 'session_revoked', `${r.status} ${r.key}`);

const tablet = await loginHr();
r = await call('POST', '/auth/change-password', { current_password: 'Passw0rd!x', new_password: 'Passw0rd!y', revoke_other_sessions: true }, laptop.token);
chk('password changed, other sessions ended', r.status === 200, `${r.status} ${r.key}`);
r = await call('GET', '/users/me', null, tablet.token);
chk('the other device is told it was the password', r.status === 401 && r.json?.data?.revoke_reason === 'password_changed', `${r.status} ${r.json?.data?.revoke_reason}`);
r = await call('GET', '/users/me', null, laptop.token);
chk('…while the device that changed it stays signed in', r.status === 200, `${r.status}`);

r = await call('GET', '/users/me', null, 'f'.repeat(64));
chk('an unknown token is a plain 401 — never "revoked"', r.status === 401 && r.key !== 'session_revoked', `${r.status} ${r.key}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
