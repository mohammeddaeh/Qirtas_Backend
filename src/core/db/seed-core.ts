/**
 * Core seed — the Permission catalog, the Role catalog, and the ar/en display
 * name of every permission. Idempotent: safe to re-run any number of times
 * (upserts by natural key — permission key / role name / (language_code, key)).
 *
 * Run via the orchestrator: `npm run db:seed` (see `seed.ts`).
 *
 * Source of truth: docs/reference/users_roles.md — "🌱 أدوار ابتدائية
 * (Seed Roles)" table. These are seed *data*, fully editable from the admin
 * panel afterward — not a hardcoded enum (see the same doc's design
 * principle section).
 *
 * The permission catalog itself is intentionally incomplete by design (see
 * the doc's Status table) — only the illustrative per-module examples are
 * seeded here; the full catalog grows as each business module gets built.
 *
 * ── Why display names live in this same file ──────────────────────────────
 * Permission display names are deliberately NOT part of the compile-time
 * ar/en easy_localization system (they are absent from the Flutter app's
 * ar.json/en.json/codegen_loader.g.dart). They live exclusively in
 * `translation_entries` — for ALL languages including ar/en — because the
 * permission catalog is dynamic data that grows as business modules get
 * built. See docs/reference/dynamic_localization.md §13.
 *
 * They were originally seeded by a separate `seed-permission-translations.ts`
 * script holding its own parallel key list, which had to be hand-synced with
 * `PERMISSIONS` below (the file carried an explicit "keep this in sync"
 * process note — a footgun, not a safeguard). Each permission now carries its
 * own `display` names, so adding a permission cannot silently forget its
 * translation: one entry, one source of truth, no cross-file sync step.
 *
 * The ar/en rows written here are a SEPARATE, parallel concept from the
 * compile-time easy_localization ar/en system — they exist solely so
 * `GET /api/v1/languages/:code/translations` has somewhere to read
 * `permission.*` keys from for those two codes. They must never be used as a
 * source for regular UI text.
 */
import { count, eq, inArray } from 'drizzle-orm';
import { db } from './client.js';
import { ensureBundledLanguagesExist, BUNDLED_LANGUAGES } from './seed-shared.js';
import { rolesTable } from '../../features/identity/schemas/roles.schema.js';
// Side-effect import: loading the routers is what makes every
// `requirePermission()` call register its key. Without it the registry is
// empty and this seed would consider the whole catalogue unenforced.
import '../../app.js';
import { isGrantable, listEnforcedPermissions, listUmbrellaKeys } from '../authz/registry.js';
import { permissionsTable } from '../../features/identity/schemas/permissions.schema.js';
import { rolePermissionsTable } from '../../features/identity/schemas/role-permissions.schema.js';
import * as languagesRepository from '../../features/localization/repositories/languages.repository.js';
import * as translationEntriesRepository from '../../features/localization/repositories/translation-entries.repository.js';
import { logger } from '../logger/logger.js';

interface SeedPermission {
  key: string;
  module: string;
  is_sensitive: boolean;
  /**
   * Human-readable name per bundled language, stored as `permission.<key>` in
   * `translation_entries`. Required — a permission with no display name would
   * render as its raw key in the app's role-detail screen.
   */
  display: { ar: string; en: string };
}

interface SeedRole {
  name: string;
  category: 'system' | 'management' | 'operational' | 'financial' | 'external';
  level: number | null;
  is_system_default: boolean;
  permissionKeys: string[];
}

const PERMISSIONS: SeedPermission[] = [
  {
    key: 'users.manage',
    module: 'users',
    is_sensitive: true,
    display: { ar: 'إدارة المستخدمين', en: 'Manage Users' },
  },
  {
    key: 'branches.manage',
    module: 'branches',
    is_sensitive: true,
    display: { ar: 'إدارة الفروع', en: 'Manage Branches' },
  },
  {
    key: 'ownerships.manage',
    module: 'ownerships',
    is_sensitive: true,
    display: { ar: 'إدارة الملكيات', en: 'Manage Ownerships' },
  },
  {
    key: 'permissions.manage',
    module: 'permissions',
    is_sensitive: true,
    display: { ar: 'إدارة الصلاحيات', en: 'Manage Permissions' },
  },
  {
    key: 'roles.view',
    module: 'roles',
    is_sensitive: false,
    display: { ar: 'عرض الأدوار', en: 'View Roles' },
  },
  /**
   * Retiring a record that HAS history — the harder half of removal.
   *
   * Held apart from `branches.manage`/`users.manage`/`roles.edit` on purpose,
   * and not because archiving is more dangerous than editing: it is that the
   * everyday manage permissions are handed out to people who run branches and
   * onboard staff, and deciding that a record with a past should stop being
   * visible is not part of that job. Whoever holds this can make a branch that
   * people worked in vanish from every list in the app; the row and the history
   * survive, but nobody goes looking in an archive they were not told about.
   *
   * Deleting a record with NO history needs only the module permission — there
   * is nothing to weigh when nothing points at the row.
   */
  {
    key: 'records.archive',
    module: 'records',
    is_sensitive: true,
    display: { ar: 'أرشفة السجلات', en: 'Archive Records' },
  },
  {
    key: 'roles.edit',
    module: 'roles',
    is_sensitive: true,
    display: { ar: 'تعديل الأدوار', en: 'Edit Roles' },
  },
  {
    key: 'dashboard.view',
    module: 'dashboard',
    is_sensitive: false,
    display: { ar: 'عرض لوحة التحكم', en: 'View Dashboard' },
  },
  {
    key: 'audit_log.view',
    module: 'audit_log',
    is_sensitive: false,
    display: { ar: 'عرض سجل التدقيق', en: 'View Audit Log' },
  },
  {
    key: 'localization.manage',
    module: 'localization',
    is_sensitive: false,
    display: { ar: 'إدارة الترجمة', en: 'Manage Localization' },
  },
  {
    key: 'reports.financial.view',
    module: 'reports',
    is_sensitive: true,
    display: { ar: 'عرض التقارير المالية', en: 'View Financial Reports' },
  },
  {
    key: 'reports.operational.view',
    module: 'reports',
    is_sensitive: false,
    display: { ar: 'عرض التقارير التشغيلية', en: 'View Operational Reports' },
  },
  {
    key: 'inventory.view',
    module: 'inventory',
    is_sensitive: false,
    display: { ar: 'عرض المخزون', en: 'View Inventory' },
  },
  {
    key: 'inventory.edit',
    module: 'inventory',
    is_sensitive: false,
    display: { ar: 'تعديل المخزون', en: 'Edit Inventory' },
  },
  {
    key: 'printing.queue.view',
    module: 'printing',
    is_sensitive: false,
    display: { ar: 'عرض قائمة انتظار الطباعة', en: 'View Printing Queue' },
  },
  {
    key: 'printing.status.update',
    module: 'printing',
    is_sensitive: false,
    display: { ar: 'تحديث حالة الطباعة', en: 'Update Printing Status' },
  },
  {
    key: 'printing.create',
    module: 'printing',
    is_sensitive: false,
    display: { ar: 'إنشاء طلب طباعة', en: 'Create Print Order' },
  },
  {
    key: 'customization.queue.view',
    module: 'customization',
    is_sensitive: false,
    display: { ar: 'عرض قائمة انتظار التخصيص', en: 'View Customization Queue' },
  },
  {
    key: 'customization.proof.approve',
    module: 'customization',
    is_sensitive: true,
    display: { ar: 'اعتماد نموذج التخصيص', en: 'Approve Customization Proof' },
  },
  {
    key: 'customization.status.update',
    module: 'customization',
    is_sensitive: false,
    display: { ar: 'تحديث حالة التخصيص', en: 'Update Customization Status' },
  },
  {
    key: 'customization.create',
    module: 'customization',
    is_sensitive: false,
    display: { ar: 'إنشاء طلب تخصيص', en: 'Create Customization Order' },
  },
  {
    key: 'orders.create',
    module: 'orders',
    is_sensitive: false,
    display: { ar: 'إنشاء طلب', en: 'Create Order' },
  },
  {
    key: 'orders.view',
    module: 'orders',
    is_sensitive: false,
    display: { ar: 'عرض الطلبات', en: 'View Orders' },
  },
  {
    key: 'orders.delivery.view',
    module: 'orders',
    is_sensitive: false,
    display: { ar: 'عرض توصيل الطلبات', en: 'View Order Delivery' },
  },
  {
    key: 'orders.delivery.update',
    module: 'orders',
    is_sensitive: false,
    display: { ar: 'تحديث توصيل الطلبات', en: 'Update Order Delivery' },
  },
  {
    key: 'orders.manage_issues',
    module: 'orders',
    is_sensitive: false,
    display: { ar: 'إدارة مشاكل الطلبات', en: 'Manage Order Issues' },
  },
  {
    key: 'customers.view',
    module: 'customers',
    is_sensitive: false,
    display: { ar: 'عرض العملاء', en: 'View Customers' },
  },
];

/**
 * Display name of each MODULE, stored as `permission.module.<module>`.
 *
 * The app groups a person's permissions by module and labels each group with
 * this entry (`PermissionsSummary` in the Flutter app). Without it the header
 * fell back to the raw-key heuristic and read "Module Users" — English, in an
 * otherwise-Arabic screen, for every locale.
 *
 * Keyed by `SeedPermission.module`, and completeness is ASSERTED at seed time
 * (see `seedPermissionDisplayNames`) — adding a permission that introduces a
 * new module fails the seed loudly instead of shipping an untranslated header.
 */
const MODULE_DISPLAY: Record<string, { ar: string; en: string }> = {
  users: { ar: 'المستخدمون', en: 'Users' },
  branches: { ar: 'الفروع', en: 'Branches' },
  ownerships: { ar: 'الملكيات', en: 'Ownerships' },
  permissions: { ar: 'الصلاحيات', en: 'Permissions' },
  roles: { ar: 'الأدوار', en: 'Roles' },
  records: { ar: 'السجلات', en: 'Records' },
  dashboard: { ar: 'لوحة التحكم', en: 'Dashboard' },
  audit_log: { ar: 'سجل التدقيق', en: 'Audit Log' },
  localization: { ar: 'الترجمة', en: 'Localization' },
  reports: { ar: 'التقارير', en: 'Reports' },
  inventory: { ar: 'المخزون', en: 'Inventory' },
  printing: { ar: 'الطباعة', en: 'Printing' },
  customization: { ar: 'التخصيص', en: 'Customization' },
  orders: { ar: 'الطلبات', en: 'Orders' },
  customers: { ar: 'العملاء', en: 'Customers' },
};

const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/**
 * **A permission is seeded only once a route enforces it.**
 *
 * [PERMISSIONS] above is a *plan*: it was written ahead of the modules, so that
 * the day `orders` ships, the roles that need it already exist and already list
 * it. Seeding the whole plan produced a catalogue that lied — on 2026-08-13,
 * **17 of 27 keys gated nothing**, and every one of them appeared in the roles
 * screen for an administrator to tick, grant, and believe in.
 *
 * So the plan stays here and the database gets only what is real. The registry
 * (`core/authz/registry.ts`) is the arbiter: it holds the keys the running
 * server actually checks, collected from the `requirePermission()` calls
 * themselves.
 *
 * The consequence worth understanding: **nothing is lost by waiting.** Write
 * `requirePermission('orders.create')` on its route, run `npm run db:seed`, and
 * the key is created and granted to every role below that planned for it — with
 * no list to remember and no second edit. That is the whole point.
 */
function isLive(key: string): boolean {
  // `isGrantable`, not `isEnforced`: an umbrella (`users.manage`) is declared by
  // no route, and treating it as dead would delete every role grant that names
  // it the next time this ran.
  return isGrantable(key);
}

/** The plan, minus what no route enforces yet. Logged so the gap is never silent. */
function livePermissions(): SeedPermission[] {
  const planned = new Map(PERMISSIONS.map((p) => [p.key, p]));

  // The umbrellas first. No route declares them — they exist so a role can say
  // "owns users" once and keep owning it when `users.export` is added next
  // year. Their display names come from the plan below, which is where the
  // coarse `users.manage` already lived before it was split.
  const umbrellas: SeedPermission[] = listUmbrellaKeys().map((key) => {
    const module = key.slice(0, key.indexOf('.'));
    const fromPlan = planned.get(key);
    return {
      key,
      module,
      is_sensitive: fromPlan?.is_sensitive ?? true,
      display: fromPlan?.display ?? {
        ar: 'إدارة كاملة',
        en: 'Full management',
      },
    };
  });

  const enforced = listEnforcedPermissions().map((enforced) => {
    const fromPlan = planned.get(enforced.key);
    const display = enforced.display ?? fromPlan?.display;

    // Neither the route nor the plan named it. Refused here, at seed time, with
    // the key in the message — the alternative is a roles screen rendering
    // `orders.create` as a label, which nobody notices until a user asks what
    // it means.
    if (!display) {
      throw new Error(
        `Permission "${enforced.key}" is enforced by a route but has no display name. ` +
          `Add it where the route declares it:\n\n` +
          `  requirePermission('${enforced.key}', {\n` +
          `    display: { ar: '…', en: '…' },\n` +
          `  })\n`,
      );
    }

    return {
      key: enforced.key,
      module: enforced.module,
      // The route wins when it says so; otherwise the plan's value, then false.
      is_sensitive: enforced.sensitive || (fromPlan?.is_sensitive ?? false),
      display,
    };
  });

  return [...enforced, ...umbrellas];
}

/**
 * The catalog as a bare key list, for `npm run check:permissions`.
 *
 * Exported so the check reads the **same array the seed writes** rather than a
 * second copy of it — a checker comparing against its own transcription of this
 * list would be one more thing that can drift, which is the exact failure it
 * exists to catch.
 */
export const SEEDED_PERMISSION_KEYS: readonly string[] = ALL_PERMISSION_KEYS;

const ROLES: SeedRole[] = [
  {
    name: 'المدير العام',
    category: 'system',
    level: 0,
    is_system_default: true,
    permissionKeys: ALL_PERMISSION_KEYS,
  },
  {
    name: 'مدقق',
    category: 'system',
    level: null,
    is_system_default: true,
    permissionKeys: ['reports.financial.view', 'reports.operational.view', 'audit_log.view'],
  },
  {
    name: 'مدير الفرع',
    category: 'management',
    level: 10,
    is_system_default: true,
    permissionKeys: [
      'inventory.view',
      'inventory.edit',
      'printing.queue.view',
      'printing.status.update',
      'customization.queue.view',
      'customization.proof.approve',
      'customization.status.update',
      'orders.create',
      'orders.view',
      'orders.delivery.view',
      'orders.delivery.update',
      'orders.manage_issues',
      'customers.view',
      'reports.operational.view',
    ],
  },
  {
    name: 'شريك مالي',
    category: 'financial',
    level: 10,
    is_system_default: true,
    permissionKeys: ['reports.financial.view'],
  },
  {
    name: 'موظف مخزون',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: ['inventory.view', 'inventory.edit'],
  },
  {
    name: 'موظف إنتاج طباعة',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: ['printing.queue.view', 'printing.status.update'],
  },
  {
    name: 'موظف إنتاج تخصيص',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: [
      'customization.queue.view',
      'customization.proof.approve',
      'customization.status.update',
    ],
  },
  {
    name: 'موظف توصيل / لوجستيات',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: ['orders.delivery.view', 'orders.delivery.update'],
  },
  {
    name: 'أمين صندوق / مبيعات',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: ['orders.create', 'orders.view', 'printing.create', 'customization.create'],
  },
  {
    name: 'خدمة العملاء',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: ['orders.view', 'orders.manage_issues', 'customers.view'],
  },
];

async function seedPermissions(): Promise<void> {
  const live = livePermissions();

  for (const permission of live) {
    await db
      .insert(permissionsTable)
      .values({
        key: permission.key,
        module: permission.module,
        is_sensitive: permission.is_sensitive,
      })
      .onConflictDoNothing({ target: permissionsTable.key });
  }

  await prunePermissionsNoRouteEnforces();

  const planned = PERMISSIONS.length - live.length;
  logger.info(
    `Seeded ${live.length} enforced permissions` +
      (planned > 0
        ? ` — ${planned} planned key(s) held back until a route declares them`
        : ''),
  );
}

/**
 * Removes catalogue rows no route enforces any more.
 *
 * Safe **because the plan lives in this file, not in the table**: a pruned key
 * and its role grants are recreated in full by the next seed, the moment its
 * route starts declaring it. Deleting is therefore reversible in the only sense
 * that matters — nothing a person authored is destroyed, only a row that was
 * promising something the server could not deliver.
 *
 * `role_permissions.permission_key` is `ON DELETE CASCADE`, so the inert grants
 * go with it. They are counted first and logged by name, because "17 grants
 * disappeared" is not something a seed should do quietly.
 */
async function prunePermissionsNoRouteEnforces(): Promise<void> {
  const rows = await db.select({ key: permissionsTable.key }).from(permissionsTable);
  const stale = rows.map((r) => r.key).filter((key) => !isLive(key));
  if (stale.length === 0) return;

  const grantRows = await db
    .select({ value: count() })
    .from(rolePermissionsTable)
    .where(inArray(rolePermissionsTable.permission_key, stale));
  const grants = grantRows[0]?.value ?? 0;

  await db.delete(permissionsTable).where(inArray(permissionsTable.key, stale));

  logger.warn(
    { keys: stale, grants_removed: grants },
    `Removed ${stale.length} permission(s) no route enforces (and ${grants} inert grant(s)). They return automatically once their routes declare them.`,
  );
}

async function seedRoles(): Promise<void> {
  for (const role of ROLES) {
    const [inserted] = await db
      .insert(rolesTable)
      .values({
        name: role.name,
        category: role.category,
        level: role.level,
        is_system_default: role.is_system_default,
        is_active: true,
      })
      .onConflictDoNothing({ target: rolesTable.name })
      .returning();

    // onConflictDoNothing returns [] when the role already exists — look it up instead of re-inserting permissions blindly.
    let roleRow = inserted;
    if (!roleRow) {
      const rows = await db
        .select()
        .from(rolesTable)
        .where(eq(rolesTable.name, role.name))
        .limit(1);
      roleRow = rows[0];
    }
    if (!roleRow) {
      throw new Error(`Failed to seed or find role "${role.name}"`);
    }

    // Filtered, not asserted: a role legitimately plans for permissions whose
    // module has not been built. Granting one would violate the foreign key —
    // and, worse, would be a grant on a key nothing checks. It lands here the
    // moment its route declares it, on the next seed run.
    for (const permissionKey of role.permissionKeys.filter(isLive)) {
      await db
        .insert(rolePermissionsTable)
        .values({ role_id: roleRow.id, permission_key: permissionKey })
        .onConflictDoNothing({
          target: [rolePermissionsTable.role_id, rolePermissionsTable.permission_key],
        });
    }
  }
  logger.info(`Seeded ${ROLES.length} roles (upsert by name, existing rows untouched)`);
}

/**
 * Writes `permission.<key>` AND `permission.module.<module>` entries for both
 * bundled languages, derived directly from `PERMISSIONS`/`MODULE_DISPLAY`
 * above — nothing to keep in sync by hand. Upserts by (language_code, key) via
 * the same repository the `PUT /:code/translations` endpoint uses, so
 * re-running only overwrites values with identical text and bumps each
 * language's `version`.
 *
 * A module with no `MODULE_DISPLAY` entry aborts the seed. The alternative —
 * skipping it — produces a screen that renders "Module Foo" in every locale,
 * which nobody notices until a user reports it. Failing here costs one line in
 * a map; failing there costs a bug report.
 */
async function seedPermissionDisplayNames(): Promise<void> {
  await ensureBundledLanguagesExist('permission display names');

  const live = livePermissions();
  const modules = [...new Set(live.map((p) => p.module))].sort();
  const untranslated = modules.filter((m) => MODULE_DISPLAY[m] === undefined);
  if (untranslated.length > 0) {
    throw new Error(
      `MODULE_DISPLAY is missing an entry for: ${untranslated.join(', ')}. ` +
        'Every module a permission belongs to must have an ar/en display name — ' +
        'the app labels permission groups with it.',
    );
  }

  for (const language of BUNDLED_LANGUAGES) {
    const code = language.code as keyof SeedPermission['display'];
    const entries: Record<string, string> = {};
    for (const permission of live) {
      entries[`permission.${permission.key}`] = permission.display[code];
    }
    for (const module of modules) {
      entries[`permission.module.${module}`] = MODULE_DISPLAY[module]![code];
    }
    await translationEntriesRepository.upsertMany(language.code, entries);
    await languagesRepository.incrementVersion(language.code);
  }

  logger.info(
    `Seeded ${live.length} permission.* + ${modules.length} permission.module.* translation entries for ${BUNDLED_LANGUAGES.map((l) => l.code).join(' + ')}`,
  );
}

/** Everything the app needs on a fresh database before anyone can log in. */
export async function seedCore(): Promise<void> {
  await seedPermissions();
  await seedRoles();
  await seedPermissionDisplayNames();
}
