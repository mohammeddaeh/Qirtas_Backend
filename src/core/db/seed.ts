/**
 * Seeds the initial Role catalog and its illustrative Permission examples.
 * Run once against a fresh database via `npm run db:seed` — safe to re-run
 * (upserts by natural key: role name / permission key).
 *
 * Source of truth: docs/reference/users_roles.md — "🌱 أدوار ابتدائية
 * (Seed Roles)" table. These are seed *data*, fully editable from the admin
 * panel afterward — not a hardcoded enum (see the same doc's design
 * principle section).
 *
 * The permission catalog itself is intentionally incomplete by design (see
 * the doc's Status table) — only the illustrative per-module examples are
 * seeded here; the full catalog grows as each business module gets built.
 */
import { eq } from 'drizzle-orm';
import { db, pool } from './client.js';
import { rolesTable } from '../../features/identity/schemas/roles.schema.js';
import { permissionsTable } from '../../features/identity/schemas/permissions.schema.js';
import { rolePermissionsTable } from '../../features/identity/schemas/role-permissions.schema.js';
import { logger } from '../logger/logger.js';

interface SeedPermission {
  key: string;
  module: string;
  is_sensitive: boolean;
}

interface SeedRole {
  name: string;
  category: 'system' | 'management' | 'operational' | 'financial' | 'external';
  level: number | null;
  is_system_default: boolean;
  permissionKeys: string[];
}

const PERMISSIONS: SeedPermission[] = [
  { key: 'roles.view', module: 'roles', is_sensitive: false },
  { key: 'roles.edit', module: 'roles', is_sensitive: true },
  { key: 'audit_log.view', module: 'audit_log', is_sensitive: false },
  { key: 'reports.financial.view', module: 'reports', is_sensitive: true },
  { key: 'reports.operational.view', module: 'reports', is_sensitive: false },
  { key: 'inventory.view', module: 'inventory', is_sensitive: false },
  { key: 'inventory.edit', module: 'inventory', is_sensitive: false },
  { key: 'printing.queue.view', module: 'printing', is_sensitive: false },
  { key: 'printing.status.update', module: 'printing', is_sensitive: false },
  { key: 'printing.create', module: 'printing', is_sensitive: false },
  { key: 'customization.queue.view', module: 'customization', is_sensitive: false },
  { key: 'customization.proof.approve', module: 'customization', is_sensitive: true },
  { key: 'customization.status.update', module: 'customization', is_sensitive: false },
  { key: 'customization.create', module: 'customization', is_sensitive: false },
  { key: 'orders.create', module: 'orders', is_sensitive: false },
  { key: 'orders.view', module: 'orders', is_sensitive: false },
  { key: 'orders.delivery.view', module: 'orders', is_sensitive: false },
  { key: 'orders.delivery.update', module: 'orders', is_sensitive: false },
  { key: 'orders.manage_issues', module: 'orders', is_sensitive: false },
  { key: 'customers.view', module: 'customers', is_sensitive: false },
];

const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const ROLES: SeedRole[] = [
  {
    name: 'Super Admin',
    category: 'system',
    level: 0,
    is_system_default: true,
    permissionKeys: ALL_PERMISSION_KEYS,
  },
  {
    name: 'Auditor',
    category: 'system',
    level: null,
    is_system_default: true,
    permissionKeys: ['reports.financial.view', 'reports.operational.view', 'audit_log.view'],
  },
  {
    name: 'Branch Manager',
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
    name: 'Financial Partner',
    category: 'financial',
    level: 10,
    is_system_default: true,
    permissionKeys: ['reports.financial.view'],
  },
  {
    name: 'Inventory Staff',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: ['inventory.view', 'inventory.edit'],
  },
  {
    name: 'Print Production Staff',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: ['printing.queue.view', 'printing.status.update'],
  },
  {
    name: 'Customization Production Staff',
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
    name: 'Delivery / Logistics Staff',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: ['orders.delivery.view', 'orders.delivery.update'],
  },
  {
    name: 'Cashier / Sales',
    category: 'operational',
    level: 20,
    is_system_default: true,
    permissionKeys: ['orders.create', 'orders.view', 'printing.create', 'customization.create'],
  },
  {
    name: 'Customer Service',
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
      .values(permission)
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

async function main(): Promise<void> {
  await seedPermissions();
  await seedRoles();
  logger.info('Seed complete');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'Seed failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
