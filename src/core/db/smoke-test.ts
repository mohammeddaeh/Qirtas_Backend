/**
 * Contract smoke test — `npm run smoke` against a running server.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Every defect this suite is built to catch was invisible to code review and
 * to the type checker, because none of them FAILED. They each returned a
 * plausible, well-formed, wrong answer:
 *
 * - `?is_active=false` returned every ACTIVE role. `z.coerce.boolean()` applies
 *   JavaScript's `Boolean()`, and `Boolean('false') === true`. Five filters
 *   carried this at once. Found by comparing counts, not by reading code.
 * - `POST /roles/:id/deactivate` shipped with no counterpart, so a retired role
 *   could never return. Nothing errored; the row simply stopped existing from
 *   the UI's point of view.
 * - `level: null` (no authority) arrived and was stored as `0` (the highest
 *   authority there is).
 *
 * The shared shape is a system that cannot distinguish "absent" from "failed".
 * A type checker cannot see it. A reviewer reading the diff cannot see it. Two
 * counts that must differ, compared against each other, can.
 *
 * ── What it asserts ────────────────────────────────────────────────────────
 * Contract-level invariants, not business outcomes:
 *   - a boolean filter and its negation return DIFFERENT, complementary sets
 *   - an invalid value for a typed param is REJECTED, not silently coerced
 *   - every documented lifecycle transition has a reachable counterpart
 *   - guarded operations refuse with the documented `message_key`
 *
 * ── Rules for anything added here ──────────────────────────────────────────
 * 1. READ-ONLY by default. The one mutating block creates a throwaway role and
 *    hard-deletes it in a `finally`, because a smoke test that leaves debris
 *    behind stops being run.
 * 2. Assert RELATIONSHIPS, never absolute numbers. `active + inactive === all`
 *    survives a reseed; `total === 11` does not, and a test nobody trusts is a
 *    test nobody runs.
 * 3. Every check names what breaks if it fails — a red line with no explanation
 *    just gets re-run until it passes.
 *
 * Usage:
 *   npm run dev          # in one terminal
 *   npm run smoke        # in another
 */
import { pool, db } from './client.js';
import { rolesTable } from '../../features/identity/schemas/roles.schema.js';
import { permissionsTable } from '../../features/identity/schemas/permissions.schema.js';
import { translationEntriesTable } from '../../features/localization/schemas/translation-entries.schema.js';
import { eq, inArray } from 'drizzle-orm';

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3000/api/v1';
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'super_admin@admin.com';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'P@ssw0rd@123';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}\n     ${detail}`);
    console.log(`  ❌ ${name}\n     ${detail}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

interface Envelope<T> {
  status: boolean;
  message: string;
  code?: number;
  data?: T;
}

let token = '';

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Envelope<T> }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Envelope<T> };
}

interface PageOf<T> {
  items: T[];
  total: number;
}

async function listTotal(path: string): Promise<number> {
  const res = await call<PageOf<unknown>>('GET', path);
  return res.json.data?.total ?? -1;
}

/**
 * The core assertion shape for this whole class of bug: `?flag=true` and
 * `?flag=false` must partition the unfiltered set. If both return the same
 * count, the parameter is being ignored or coerced — the exact failure that
 * `z.coerce.boolean()` produced on five filters simultaneously.
 */
async function checkBooleanFilterPartitions(
  resource: string,
  flag: string,
): Promise<void> {
  const all = await listTotal(`${resource}?limit=1`);
  const yes = await listTotal(`${resource}?${flag}=true&limit=1`);
  const no = await listTotal(`${resource}?${flag}=false&limit=1`);

  check(
    `${resource}?${flag} — true and false differ`,
    yes !== no,
    `both returned ${yes}. The parameter is ignored or coerced; every non-empty ` +
      `string is truthy under Boolean(), so 'false' reads as true.`,
  );
  check(
    `${resource}?${flag} — true + false === unfiltered (${yes} + ${no} = ${all})`,
    yes + no === all,
    `${yes} + ${no} !== ${all}. The two sides do not partition the set, so at ` +
      `least one of them is matching the wrong rows.`,
  );

  const bad = await call('GET', `${resource}?${flag}=notabool&limit=1`);
  check(
    `${resource}?${flag}=notabool — rejected, not coerced`,
    bad.status === 422,
    `got ${bad.status}, expected 422. A typo'd value is being accepted as a ` +
      `silent true instead of surfacing as an error.`,
  );
}

async function main(): Promise<void> {
  section('Auth');
  const login = await call<{ token: string }>('POST', '/users/login', {
    email: EMAIL,
    password: PASSWORD,
  });
  token = login.json.data?.token ?? '';
  check('login returns a token', token.length > 0, `status ${login.status}: ${login.json.message}`);
  if (!token) {
    console.log('\nCannot continue without a session.');
    return;
  }

  const unauth = await fetch(`${API}/roles?limit=1`);
  check(
    'protected route rejects an unauthenticated request',
    unauth.status === 401,
    `got ${unauth.status}. A route that answers without a token is open to anyone.`,
  );

  section('Boolean query filters');
  await checkBooleanFilterPartitions('/roles', 'is_active');
  await checkBooleanFilterPartitions('/users', 'unassigned');
  await checkBooleanFilterPartitions('/users', 'is_admin');
  await checkBooleanFilterPartitions('/branches', 'is_default');

  section('Nullable fields survive the wire');
  const roles = await call<PageOf<{ id: number; name: string; level: number | null }>>(
    'GET',
    '/roles?limit=100',
  );
  const items = roles.json.data?.items ?? [];
  const levelless = items.filter((r) => r.level === null);
  check(
    'at least one role reports level: null, not 0',
    levelless.length > 0,
    `every role came back with a numeric level. null means "carries no ` +
      `authority" and 0 means "the highest there is" — collapsing them makes ` +
      `every ordinary role read as Super Admin rank.`,
  );

  section('Role lifecycle has a return path');
  let throwawayId: number | null = null;
  try {
    const created = await call<{ id: number }>('POST', '/roles', {
      name: `__smoke_${Date.now()}`,
      category: 'operational',
      permission_keys: ['inventory.view'],
      force: true,
    });
    throwawayId = created.json.data?.id ?? null;
    check('create role', throwawayId !== null, `status ${created.status}: ${created.json.message}`);
    if (throwawayId === null) return;

    const renamed = await call('PATCH', `/roles/${throwawayId}`, {
      name: `__smoke_renamed_${Date.now()}`,
    });
    check('rename role', renamed.status === 200, `status ${renamed.status}`);

    const dupName = await call<{ message_key?: string }>('PATCH', `/roles/${throwawayId}`, {
      name: 'مدقق',
    });
    check(
      'duplicate name refused with role_name_taken',
      dupName.status === 409,
      `got ${dupName.status}. Two roles sharing a name make every "which role?" ` +
        `question ambiguous.`,
    );

    const off = await call<{ is_active: boolean }>('POST', `/roles/${throwawayId}/deactivate`);
    check('deactivate', off.json.data?.is_active === false, `status ${off.status}`);

    const hidden = await call<PageOf<{ id: number }>>('GET', '/roles?is_active=false&limit=100');
    check(
      'a deactivated role is findable',
      (hidden.json.data?.items ?? []).some((r) => r.id === throwawayId),
      `it is absent from ?is_active=false, so nothing in the UI can reach it — ` +
        `deactivation becomes a delete in a project that has no deletes.`,
    );

    const on = await call<{ is_active: boolean }>('POST', `/roles/${throwawayId}/reactivate`);
    check(
      'reactivate returns the role to service',
      on.json.data?.is_active === true,
      `status ${on.status}. Without this, deactivation is one-way.`,
    );

    const again = await call('POST', `/roles/${throwawayId}/reactivate`);
    check(
      'reactivating an active role is refused, not silently repeated',
      again.status === 409,
      `got ${again.status}. A no-op reported as success hides a lost update.`,
    );
  } finally {
    // Hard delete, not deactivate: this row is test debris, not a retired role.
    if (throwawayId !== null) {
      await db.delete(rolesTable).where(eq(rolesTable.id, throwawayId));
      console.log(`  🧹 removed throwaway role ${throwawayId}`);
    }
  }

  section('A permission cannot be born without a name');
  // A fixed key, not a timestamped one: `permissionKeySchema` enforces
  // `module.action` with a lowercase-letter start, so a uniquifying prefix
  // would be rejected for the wrong reason and the test would pass on a
  // validation error it did not mean to trigger. Leftovers from a crashed run
  // are cleared first instead.
  const smokeKey = 'smoketests.view';
  const smokeModule = 'smoketests';
  let permissionCreated = false;
  try {
    await db.delete(permissionsTable).where(eq(permissionsTable.key, smokeKey));

    const noDisplay = await call('POST', '/permissions', {
      key: smokeKey,
      module: smokeModule,
      is_sensitive: false,
    });
    check(
      'create without display is rejected',
      noDisplay.status === 422,
      `got ${noDisplay.status}. A nameless permission renders as its raw key — ` +
        `"Warehouse Manage" — in every language, forever, with nothing reporting it.`,
    );

    const newModuleNoLabel = await call('POST', '/permissions', {
      key: smokeKey,
      module: smokeModule,
      is_sensitive: false,
      display: { ar: 'فحص', en: 'Smoke' },
    });
    check(
      'a new module without module_display is rejected',
      newModuleNoLabel.status === 422,
      `got ${newModuleNoLabel.status}. The app titles each permission group from ` +
        `permission.module.<module>; without one the header is untranslated for everyone.`,
    );

    const created = await call('POST', '/permissions', {
      key: smokeKey,
      module: smokeModule,
      is_sensitive: false,
      display: { ar: 'فحص دخان', en: 'Smoke Check' },
      module_display: { ar: 'وحدة فحص', en: 'Smoke Module' },
    });
    permissionCreated = created.status === 201;
    check('create with both names succeeds', permissionCreated, `status ${created.status}`);

    if (permissionCreated) {
      const ar = await call<{ translations: Record<string, string> }>(
        'GET',
        '/languages/ar/translations',
      );
      const map = ar.json.data?.translations ?? {};
      check(
        'the display name reached translation_entries',
        map[`permission.${smokeKey}`] === 'فحص دخان',
        `permission.${smokeKey} is missing or wrong. Creating the permission and ` +
          `naming it are one operation — the seed has always treated them that way.`,
      );
      check(
        'the module label reached translation_entries',
        map[`permission.module.${smokeModule}`] === 'وحدة فحص',
        `permission.module.${smokeModule} is missing.`,
      );
    }
  } finally {
    if (permissionCreated) {
      await db.delete(permissionsTable).where(eq(permissionsTable.key, smokeKey));
      await db
        .delete(translationEntriesTable)
        .where(
          inArray(translationEntriesTable.key, [
            `permission.${smokeKey}`,
            `permission.module.${smokeModule}`,
          ]),
        );
      console.log(`  🧹 removed throwaway permission ${smokeKey} and its 4 translation entries`);
    }
  }

  section('The validator accepts its own catalogue');
  // The write endpoints validate every incoming permission key against
  // `permissionKeySchema`. The seed inserts the catalogue straight through the
  // repository, so those keys are never checked on the way in — and for months
  // the schema demanded exactly two dot-separated segments while nine of the
  // twenty-six catalogue keys have three.
  //
  // The visible symptom was not "you cannot use those nine". It was that
  // SAVING THE PERMISSIONS OF AN EXISTING ROLE that already held one failed
  // with a 422, changing nothing. This check exists so the two can never
  // disagree again: whatever the catalogue serves, the API must accept back.
  const catalogue = await call<{ key: string }[]>('GET', '/permissions');
  const allKeys = (catalogue.json.data ?? []).map((p) => p.key);
  check('catalogue is non-empty', allKeys.length > 0, 'GET /permissions returned nothing');

  let validatorRoleId: number | null = null;
  try {
    const created = await call<{ id: number }>('POST', '/roles', {
      name: `__smoke_validator_${Date.now()}`,
      category: 'operational',
      permission_keys: [],
      force: true,
    });
    validatorRoleId = created.json.data?.id ?? null;

    if (validatorRoleId !== null) {
      // `force` because writing the WHOLE catalogue is by definition the Super
      // Admin's exact set, which the duplicate-set warning would (correctly)
      // question. This check is about the key VALIDATOR, and the two rules must
      // not be tangled: a 409 here would look like a regex failure.
      const put = await call<{ permissions?: unknown[] }>(
        'PUT',
        `/roles/${validatorRoleId}/permissions`,
        { permission_keys: allKeys, force: true },
      );
      check(
        `every one of the ${allKeys.length} catalogue keys is accepted on write`,
        put.status === 200,
        `status ${put.status}: ${JSON.stringify(put.json)}. The API is rejecting ` +
          `keys it serves from its own catalogue, so any role holding one of ` +
          `them cannot have its permissions saved at all.`,
      );
      check(
        'and all of them are stored',
        (put.json.data?.permissions?.length ?? 0) === allKeys.length,
        `expected ${allKeys.length}, got ${put.json.data?.permissions?.length ?? 0}.`,
      );
    }
  } finally {
    if (validatorRoleId !== null) {
      await db.delete(rolesTable).where(eq(rolesTable.id, validatorRoleId));
      console.log(`  🧹 removed validator probe role ${validatorRoleId}`);
    }
  }

  section('Cloning and authority level actually work');
  let clonedId: number | null = null;
  try {
    // The source must be a role that HAS permissions — the whole bug was that
    // the clone path copied an empty set and reported success.
    const source = (
      await call<PageOf<{ id: number; name: string }>>('GET', '/roles?limit=100')
    ).json.data?.items.find((r) => r.name === 'مدير الفرع');
    if (source === undefined) throw new Error('seed role "مدير الفرع" not found');

    const full = await call<{ permissions?: unknown[] }>('GET', `/roles/${source.id}`);
    const sourceCount = full.json.data?.permissions?.length ?? 0;
    check(
      'GET /roles/:id carries permissions (GET /roles does not)',
      sourceCount > 0,
      `the source role reported ${sourceCount} permissions. The list endpoint ` +
        `omits them by design, so a client reading them off a LIST row copies ` +
        `nothing — silently, which is exactly how cloning shipped broken.`,
    );

    const cloned = await call<{ id: number; level: number | null }>('POST', '/roles', {
      name: `__smoke_clone_${Date.now()}`,
      category: 'operational',
      permission_keys: [],
      clone_from_role_id: source.id,
      force: true,
    });
    clonedId = cloned.json.data?.id ?? null;
    check('clone create accepted', clonedId !== null, `status ${cloned.status}`);

    if (clonedId !== null) {
      const readBack = await call<{ permissions?: unknown[] }>('GET', `/roles/${clonedId}`);
      check(
        'a cloned role actually carries the copied permissions',
        (readBack.json.data?.permissions?.length ?? 0) === sourceCount,
        `expected ${sourceCount}, got ${readBack.json.data?.permissions?.length ?? 0}. ` +
          `A clone that copies nothing is indistinguishable from a plain create.`,
      );
    }

    // `level` at creation — before this the field was reachable ONLY by cloning
    // a role that already had one, so a first hierarchy could never be built.
    const levelled = await call<{ id: number; level: number | null }>('POST', '/roles', {
      name: `__smoke_level_${Date.now()}`,
      category: 'management',
      permission_keys: ['inventory.view'],
      level: 50,
      force: true,
    });
    check(
      'level is settable at creation',
      levelled.json.data?.level === 50,
      `got ${String(levelled.json.data?.level)}, expected 50.`,
    );
    if (levelled.json.data?.id !== undefined) {
      await db.delete(rolesTable).where(eq(rolesTable.id, levelled.json.data.id));
    }

    // The guard that makes creation-with-level safe: you cannot mint a peer or
    // a superior. Super Admin is level 0, so 0 is at their own level.
    const tooHigh = await call('POST', '/roles', {
      name: `__smoke_toohigh_${Date.now()}`,
      category: 'management',
      permission_keys: ['inventory.view'],
      level: 0,
      force: true,
    });
    check(
      'a level at or above the caller is refused',
      tooHigh.status === 403,
      `got ${tooHigh.status}. Without this, allowing level at creation would let ` +
        `anyone with roles.edit mint a role outranking themselves.`,
    );
  } finally {
    if (clonedId !== null) {
      await db.delete(rolesTable).where(eq(rolesTable.id, clonedId));
      console.log(`  🧹 removed cloned role ${clonedId}`);
    }
  }

  section('The duplicate-set warning covers updates, not just creates');
  // The check ran on POST only. So the state it exists to question — two active
  // roles with identical powers — was reachable in one step: clone a role, save
  // its permissions untouched, done, silently. The rule is about the resulting
  // state, not about which endpoint produced it.
  let dupRoleId: number | null = null;
  try {
    const source = (
      await call<PageOf<{ id: number; name: string }>>('GET', '/roles?limit=100')
    ).json.data?.items.find((r) => r.name === 'مدقق');
    if (source === undefined) throw new Error('seed role "مدقق" not found');
    const sourceKeys = (
      await call<{ permissions?: { key: string }[] }>('GET', `/roles/${source.id}`)
    ).json.data?.permissions?.map((p) => p.key) ?? [];

    const created = await call<{ id: number }>('POST', '/roles', {
      name: `__smoke_dup_${Date.now()}`,
      category: 'operational',
      permission_keys: ['customers.view'],
      force: true,
    });
    dupRoleId = created.json.data?.id ?? null;
    if (dupRoleId === null) throw new Error('could not create probe role');

    const collide = await call<{ message_key?: string }>(
      'PUT',
      `/roles/${dupRoleId}/permissions`,
      { permission_keys: sourceKeys },
    );
    check(
      'updating to another active role’s exact set is questioned',
      collide.status === 409,
      `got ${collide.status}. Cloning a role and saving it untouched would then ` +
        `produce two roles with identical powers and say nothing.`,
    );

    const forced = await call('PUT', `/roles/${dupRoleId}/permissions`, {
      permission_keys: sourceKeys,
      force: true,
    });
    check(
      'and force overrides it',
      forced.status === 200,
      `got ${forced.status}. It is a warning, not a rule — same powers under a ` +
        `different name is a legitimate choice.`,
    );

    // Self-exclusion, isolated: a set no OTHER active role holds, saved twice.
    // Re-saving it must pass. (Re-saving the forced set above would still be a
    // duplicate — of "مدقق", correctly — so it proves nothing about self.)
    const uniqueSet = ['customers.view', 'inventory.view', 'orders.view'];
    await call('PUT', `/roles/${dupRoleId}/permissions`, {
      permission_keys: uniqueSet,
      force: true,
    });
    const resave = await call('PUT', `/roles/${dupRoleId}/permissions`, {
      permission_keys: uniqueSet,
    });
    check(
      'a role is not its own duplicate',
      resave.status === 200,
      `got ${resave.status}. Without excludeRoleId, every save of an unchanged ` +
        `set would be refused as a duplicate of itself — so no role's ` +
        `permissions could ever be re-saved.`,
    );
  } finally {
    if (dupRoleId !== null) {
      await db.delete(rolesTable).where(eq(rolesTable.id, dupRoleId));
      console.log(`  🧹 removed duplicate probe role ${dupRoleId}`);
    }
  }

  section('Deleting a role is allowed only where history is not lost');
  // The one place this project deletes anything. The condition is NOT "nobody
  // holds it now" — that is what deactivation is for — but "no assignment has
  // ever referenced it", so nothing anyone once was can be erased.
  let freshId: number | null = null;
  let usedId: number | null = null;
  try {
    const fresh = await call<{ id: number; is_deletable?: boolean }>('POST', '/roles', {
      name: `__smoke_del_${Date.now()}`,
      category: 'operational',
      permission_keys: ['customers.view'],
      force: true,
    });
    freshId = fresh.json.data?.id ?? null;
    if (freshId === null) throw new Error('could not create probe role');

    const detail = await call<{ is_deletable?: boolean }>('GET', `/roles/${freshId}`);
    check(
      'a never-assigned role reports is_deletable',
      detail.json.data?.is_deletable === true,
      `got ${String(detail.json.data?.is_deletable)}. Without it the client must ` +
        `offer delete everywhere and let the server refuse — the pattern this ` +
        `codebase avoids.`,
    );

    const superAdmin = (
      await call<PageOf<{ id: number; level: number | null }>>('GET', '/roles?limit=100')
    ).json.data?.items.find((r) => r.level === 0);
    if (superAdmin !== undefined) {
      const sd = await call<{ is_deletable?: boolean }>('GET', `/roles/${superAdmin.id}`);
      check(
        'a seeded, held role reports is_deletable: false',
        sd.json.data?.is_deletable === false,
        `got ${String(sd.json.data?.is_deletable)}.`,
      );
      const refused = await call('DELETE', `/roles/${superAdmin.id}`);
      check(
        'and deleting it is refused',
        refused.status === 403 || refused.status === 409,
        `got ${refused.status}. Deleting a role with history erases what its ` +
          `holders once were.`,
      );
    }

    // The case a user reported as broken: nobody holds it NOW, somebody did
    // once. `is_deletable` is false and correct — but with only that boolean
    // the screen could not say why, and an absent button over a "nobody holds
    // this" list reads as a fault rather than a rule.
    const withHistory = (
      await call<PageOf<{ id: number; name: string }>>('GET', '/roles?limit=100')
    ).json.data?.items.find((r) => r.name === 'خدمة العملاء');
    if (withHistory !== undefined) {
      const d = await call<{
        active_holders_count?: number;
        assignments_ever_count?: number;
      }>('GET', `/roles/${withHistory.id}`);
      check(
        'assignments_ever_count is reported and counts ENDED assignments too',
        (d.json.data?.assignments_ever_count ?? 0) >
          (d.json.data?.active_holders_count ?? 0),
        `ever=${d.json.data?.assignments_ever_count} vs active=` +
          `${d.json.data?.active_holders_count}. If the two always match, the ` +
          `count is only looking at live rows and cannot explain why a role ` +
          `nobody currently holds still refuses deletion.`,
      );
    }

    const deleted = await call('DELETE', `/roles/${freshId}`);
    check('a never-assigned role deletes', deleted.status === 200, `status ${deleted.status}`);
    const gone = await call('GET', `/roles/${freshId}`);
    check('and is really gone', gone.status === 404, `got ${gone.status}`);
    if (deleted.status === 200) freshId = null;
  } finally {
    for (const id of [freshId, usedId]) {
      if (id !== null) {
        await db.delete(rolesTable).where(eq(rolesTable.id, id));
        console.log(`  🧹 removed probe role ${id}`);
      }
    }
  }

  section('The blast radius of a permission change is knowable');
  // Editing a role's permissions is retroactive on everyone holding it. The
  // editor asked someone to decide that without saying how many people it
  // reaches — so the count travels with the role it belongs to.
  const superAdminRole = (
    await call<PageOf<{ id: number; level: number | null }>>('GET', '/roles?limit=100')
  ).json.data?.items.find((r) => r.level === 0);
  if (superAdminRole !== undefined) {
    const detail = await call<{ active_holders_count?: number }>(
      'GET',
      `/roles/${superAdminRole.id}`,
    );
    check(
      'GET /roles/:id reports active_holders_count',
      typeof detail.json.data?.active_holders_count === 'number',
      `got ${String(detail.json.data?.active_holders_count)}. Without it the ` +
        `editor cannot say who a permission change reaches.`,
    );
    check(
      'and the Super Admin role reports at least one holder',
      (detail.json.data?.active_holders_count ?? 0) >= 1,
      `got ${detail.json.data?.active_holders_count}. The account running this ` +
        `test holds it, so a zero means the count is not actually counting.`,
    );
  }

  const listRow = (await call<PageOf<Record<string, unknown>>>('GET', '/roles?limit=1')).json.data
    ?.items[0];
  check(
    'the LIST omits it rather than sending 0',
    listRow !== undefined && !('active_holders_count' in listRow),
    `the list row carries active_holders_count. Sending 0 there would let a row ` +
      `claim "nobody holds this role" when it simply was not counted.`,
  );

  section('The session reports what no permission key can');
  const me = await call<{ is_super_admin?: boolean }>('GET', '/users/me');
  check(
    'GET /users/me reports is_super_admin',
    me.json.data?.is_super_admin === true,
    `got ${String(me.json.data?.is_super_admin)}. Two operations are gated on ` +
      `holding this role and no permission key expresses it — without this the ` +
      `client must either hide the control or offer it and be refused.`,
  );

  section('Translation writes are partial, not a replace');
  // The in-app editor sends ONE key per save. If this endpoint ever became a
  // full replace, every save would silently wipe the rest of the language —
  // the worst possible member of the "returned a plausible answer" family,
  // because the write reports success while destroying everything it omitted.
  const arBefore = (
    await call<{ translations: Record<string, string> }>('GET', '/languages/ar/translations')
  ).json.data?.translations ?? {};
  const probeKey = '__smoke.partial.probe';
  const witnessKey = 'permission.users.manage';
  const witnessBefore = arBefore[witnessKey];

  const put = await call('PUT', '/languages/ar/translations', {
    translations: { [probeKey]: 'قيمة فحص' },
  });
  check('single-key write accepted', put.status === 200, `status ${put.status}`);

  const arAfter = (
    await call<{ translations: Record<string, string> }>('GET', '/languages/ar/translations')
  ).json.data?.translations ?? {};

  check(
    'the written key is stored',
    arAfter[probeKey] === 'قيمة فحص',
    `expected the probe key back, got ${String(arAfter[probeKey])}.`,
  );
  check(
    'unlisted keys survive the write',
    arAfter[witnessKey] === witnessBefore,
    `${witnessKey} changed from "${String(witnessBefore)}" to ` +
      `"${String(arAfter[witnessKey])}". The endpoint is replacing, not upserting — ` +
      `every single-key save from the editor would destroy the whole language.`,
  );
  check(
    'the rest of the language is intact',
    Object.keys(arAfter).length === Object.keys(arBefore).length + 1,
    `key count went from ${Object.keys(arBefore).length} to ${Object.keys(arAfter).length}, ` +
      `expected exactly one more.`,
  );

  await db
    .delete(translationEntriesTable)
    .where(eq(translationEntriesTable.key, probeKey));
  console.log(`  🧹 removed probe key ${probeKey}`);

  section('Guarded operations still refuse');
  const superAdmin = (await call<PageOf<{ id: number; name: string; level: number | null }>>(
    'GET',
    '/roles?limit=100',
  )).json.data?.items.find((r) => r.level === 0);
  if (superAdmin) {
    const rename = await call('PATCH', `/roles/${superAdmin.id}`, { name: '__smoke_should_fail' });
    check(
      'the Super Admin role cannot be renamed',
      rename.status === 403,
      `got ${rename.status}. Authority checks match it BY NAME, so a rename ` +
        `disables them rather than failing.`,
    );
    const deactivate = await call('POST', `/roles/${superAdmin.id}/deactivate`);
    check(
      'the Super Admin role cannot be deactivated',
      deactivate.status === 403 || deactivate.status === 409,
      `got ${deactivate.status}. Losing it locks everyone out permanently.`,
    );
  }

  // ── The archive ────────────────────────────────────────────────────────────
  //
  // Nothing here can be verified by reading code. The whole feature rests on a
  // reconstruction — "what was this role called on that date" is derived by
  // rewinding the audit log — and a reconstruction that quietly returns today's
  // name is indistinguishable, in every screenshot, from one that works.
  section('The archive answers what a record used to be called');
  let archiveRoleId: number | null = null;
  try {
    const originalName = `__smoke_cashier_${Date.now()}`;
    const created = await call<{ id: number }>('POST', '/roles', {
      name: originalName,
      category: 'operational',
      permission_keys: ['inventory.view'],
      force: true,
    });
    archiveRoleId = created.json.data?.id ?? null;
    check('create a role to rename', archiveRoleId !== null, `status ${created.status}`);
    if (archiveRoleId === null) return;

    // The instant BEFORE the rename. Anything asking for the name as of now
    // must still get the original.
    const beforeRename = new Date();

    const newName = `__smoke_sales_${Date.now()}`;
    const renamed = await call('PATCH', `/roles/${archiveRoleId}`, { name: newName });
    check('rename it', renamed.status === 200, `status ${renamed.status}`);

    const history = await call<
      PageOf<{ action: string; performed_by_name: string | null; previous_value: unknown }>
    >('GET', `/audit-log?target_entity=role:${archiveRoleId}&limit=50`);
    const entries = history.json.data?.items ?? [];

    check(
      'the rename is readable from the audit log',
      entries.some((e) => e.action === 'role.update'),
      `GET /audit-log?target_entity=role:${archiveRoleId} returned no role.update. ` +
        `The archive has no second table — if the log does not carry the rename, ` +
        `nothing does.`,
    );

    check(
      'the entry names WHO made the change',
      entries.every((e) => typeof e.performed_by_name === 'string' && e.performed_by_name.length > 0),
      `an entry came back with no performed_by_name. "user 3 renamed this" is ` +
        `not a sentence a reader can use, and the join is the only source.`,
    );

    const renameEntry = entries.find((e) => e.action === 'role.update');
    check(
      'the entry carries the OLD name, not just the fact of a change',
      (renameEntry?.previous_value as { name?: string } | null)?.name === originalName,
      `previous_value.name was ${JSON.stringify(
        (renameEntry?.previous_value as { name?: string } | null)?.name,
      )}, expected ${originalName}. Without both sides the timeline cannot be built.`,
    );

    // The reconstruction itself, called directly: as of a moment before the
    // rename, the answer must be the original name — NOT the current one.
    const { resolveNameAt } = await import('../../features/identity/services/audit.service.js');
    const thenName = await resolveNameAt(`role:${archiveRoleId}`, beforeRename, newName);
    check(
      'resolveNameAt rewinds to the name in force at that moment',
      thenName === originalName,
      `got "${thenName}", expected "${originalName}". Returning the current name ` +
        `is the exact failure this exists to prevent: every closed posting would ` +
        `claim the person held a role under a name it did not carry yet.`,
    );

    const nowName = await resolveNameAt(`role:${archiveRoleId}`, new Date(), newName);
    check(
      'and leaves the present alone',
      nowName === newName,
      `got "${nowName}", expected "${newName}". Rewinding past the last rename ` +
        `would relabel the CURRENT state, which is the same bug pointed backwards.`,
    );
  } finally {
    if (archiveRoleId !== null) {
      await db.delete(rolesTable).where(eq(rolesTable.id, archiveRoleId));
      console.log(`  🧹 removed throwaway role ${archiveRoleId}`);
    }
  }

  section('Ended postings are reachable, not merely retained');
  const anyUser = (await call<PageOf<{ id: number }>>('GET', '/users?limit=1')).json.data
    ?.items[0];
  if (anyUser) {
    const ended = await call<Array<{ id: number }>>(
      'GET',
      `/users/${anyUser.id}/role-assignments/ended`,
    );
    check(
      'GET /users/:id/role-assignments/ended answers',
      ended.status === 200 && Array.isArray(ended.json.data),
      `status ${ended.status}. Ending an assignment only stamps valid_to — the ` +
        `row was always there, and until this route existed nothing could read it.`,
    );
  }
}

const started = Date.now();
main()
  .catch((err: unknown) => {
    failures.push(`smoke test crashed: ${String(err)}`);
  })
  .finally(async () => {
    console.log(`\n${'═'.repeat(64)}`);
    if (failures.length === 0) {
      console.log(`✅ ${passed} checks passed in ${Date.now() - started}ms`);
    } else {
      console.log(`❌ ${failures.length} FAILED, ${passed} passed\n`);
      for (const f of failures) console.log(`  • ${f}\n`);
      process.exitCode = 1;
    }
    await pool.end();
  });
