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
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { ensureBundledLanguagesExist, BUNDLED_LANGUAGES } from './seed-shared.js';
import { rolesTable } from '../../features/identity/schemas/roles.schema.js';
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

const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

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
  for (const permission of PERMISSIONS) {
    await db
      .insert(permissionsTable)
      .values({
        key: permission.key,
        module: permission.module,
        is_sensitive: permission.is_sensitive,
      })
      .onConflictDoNothing({ target: permissionsTable.key });
  }
  logger.info(`Seeded ${PERMISSIONS.length} permissions (upsert, existing rows untouched)`);
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

    for (const permissionKey of role.permissionKeys) {
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
 * Writes `permission.<key>` entries for both bundled languages, derived
 * directly from `PERMISSIONS` above — nothing to keep in sync by hand.
 * Upserts by (language_code, key) via the same repository the
 * `PUT /:code/translations` endpoint uses, so re-running only overwrites
 * values with identical text and bumps each language's `version`.
 */
async function seedPermissionDisplayNames(): Promise<void> {
  await ensureBundledLanguagesExist('permission display names');

  for (const language of BUNDLED_LANGUAGES) {
    const code = language.code as keyof SeedPermission['display'];
    const entries: Record<string, string> = {};
    for (const permission of PERMISSIONS) {
      entries[`permission.${permission.key}`] = permission.display[code];
    }
    await translationEntriesRepository.upsertMany(language.code, entries);
    await languagesRepository.incrementVersion(language.code);
  }

  logger.info(
    `Seeded ${PERMISSIONS.length} permission.* translation entries for ${BUNDLED_LANGUAGES.map((l) => l.code).join(' + ')}`,
  );
}

/** Everything the app needs on a fresh database before anyone can log in. */
export async function seedCore(): Promise<void> {
  await seedPermissions();
  await seedRoles();
  await seedPermissionDisplayNames();
}
