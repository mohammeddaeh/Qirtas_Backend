/**
 * Seeds realistic Arabic demo data (branches + varied-status users across all
 * 9 system-default roles) for local manual testing/QA of list screens —
 * pagination, filtering, sorting — against something richer than an empty or
 * single-row table. This script IS the project's standing "start fresh" point:
 * re-run it after any progress to get back a clean, realistic, sufficiently-
 * sized dataset to re-test against — that is its whole purpose, not a one-off.
 *
 * Creation goes through the real service layer (not raw repository inserts)
 * so every business rule that would run from the real app (password hashing,
 * role/branch validation, ownership-cap checks, the self-registration +
 * decide-registration flow) actually runs here too.
 *
 * `--reset` performs a REAL hard delete of every row this script owns —
 * every `@qirtas.test`-tagged user and every demo branch (by name, see
 * BRANCH_DEFS) — then re-seeds from scratch. This is a deliberate, narrowly-
 * scoped exception to the project's "no hard delete" rule (core/CLAUDE.md
 * §CRUD): it only ever touches rows this script itself created, identified
 * by the `@qirtas.test` email domain / exact demo branch names, never real
 * data. Delete order respects FK constraints (see schema `onDelete` modes):
 * audit_log_entries (user_id is RESTRICT) → users (cascades assignments +
 * ownerships automatically) → branches (now unreferenced).
 *
 * Role names referenced below (`role: 'مدير الفرع'`, etc.) must match the 9
 * system-default Arabic role names exactly as seeded by `seed.ts` — those
 * were renamed from their original English names on 2026-07-28; see
 * `roles.service.ts`'s `SUPER_ADMIN_ROLE_NAME` for the one name with real
 * branching logic (deactivation/level-edit protection).
 *
 * Run: `npm run db:seed -- --demo --reset` (the normal way to use this — omit
 * `--reset` only to top up on top of an existing, non-demo run). Invoked by
 * the orchestrator in `seed.ts`; this module never opens or closes the pool.
 */
import { inArray, or, eq, like } from 'drizzle-orm';
import { db } from './client.js';
import { DEMO_EMAIL_SUFFIX } from './seed-shared.js';
import { logger } from '../logger/logger.js';
import { usersTable } from '../../features/identity/schemas/users.schema.js';
import { branchesTable } from '../../features/identity/schemas/branches.schema.js';
import { auditLogEntriesTable } from '../../features/identity/schemas/audit-log-entries.schema.js';
import * as branchesService from '../../features/identity/services/branches.service.js';
import * as branchesRepository from '../../features/identity/repositories/branches.repository.js';
import * as usersService from '../../features/identity/services/users.service.js';
import * as usersRepository from '../../features/identity/repositories/users.repository.js';
import * as rolesRepository from '../../features/identity/repositories/roles.repository.js';
import type { RequestActorContext } from '../http/require-actor.js';

const DEMO_PASSWORD = '12345678'; // dev-only — needs PASSWORD_POLICY=relaxed to be *typed*; seeding bypasses the policy

// ── Role names (Arabic — must match seed.ts exactly) ───────────────────────
const ROLE = {
  superAdmin: 'المدير العام',
  auditor: 'مدقق',
  branchManager: 'مدير الفرع',
  financialPartner: 'شريك مالي',
  inventoryStaff: 'موظف مخزون',
  printStaff: 'موظف إنتاج طباعة',
  customizationStaff: 'موظف إنتاج تخصيص',
  deliveryStaff: 'موظف توصيل / لوجستيات',
  cashier: 'أمين صندوق / مبيعات',
  customerService: 'خدمة العملاء',
} as const;

// ── Branches ─────────────────────────────────────────────────────────────

interface BranchDef {
  name: string;
  address: string;
  contact_info: string;
  status?: 'active' | 'temporarily_closed' | 'closed';
}

// contact_info is a phone number too (see syrianPhoneSchema at
// core/validation/common-schemas.ts) — always 10 digits, starting "09".
const BRANCH_DEFS: BranchDef[] = [
  { name: 'فرع دمشق - المزة', address: 'شارع المزة، بناء رقم 12، دمشق', contact_info: '0911234567' },
  { name: 'فرع دمشق - أبو رمانة', address: 'حي أبو رمانة، دمشق', contact_info: '0911234568' },
  { name: 'فرع دمشق - المالكي', address: 'حي المالكي، دمشق', contact_info: '0911234569' },
  { name: 'فرع حلب - الفرقان', address: 'حي الفرقان، شارع النيل، حلب', contact_info: '0921234567' },
  { name: 'فرع حلب - الجميلية', address: 'حي الجميلية، حلب', contact_info: '0921234568' },
  { name: 'فرع حلب - الشهباء', address: 'حي الشهباء، حلب', contact_info: '0921234569' },
  { name: 'فرع حمص - الوعر', address: 'حي الوعر، شارع الحرية، حمص', contact_info: '0931234567' },
  { name: 'فرع حمص - الإنشاءات', address: 'حي الإنشاءات، حمص', contact_info: '0931234568' },
  {
    name: 'فرع اللاذقية - الزراعة',
    address: 'شارع الزراعة، اللاذقية',
    contact_info: '0941234567',
  },
  {
    name: 'فرع اللاذقية - الشيخ ضاهر',
    address: 'حي الشيخ ضاهر، اللاذقية',
    contact_info: '0941234568',
  },
  {
    name: 'فرع طرطوس - الكورنيش',
    address: 'كورنيش طرطوس البحري',
    contact_info: '0951234567',
    status: 'temporarily_closed',
  },
  { name: 'فرع درعا - المركز', address: 'شارع المركز، درعا', contact_info: '0961234567' },
  { name: 'فرع دير الزور - الجورة', address: 'حي الجورة، دير الزور', contact_info: '0971234567' },
  { name: 'فرع الحسكة - المركز', address: 'شارع المركز، الحسكة', contact_info: '0981234567' },
  { name: 'فرع السويداء - المركز', address: 'شارع المركز، السويداء', contact_info: '0991234567' },
];

/**
 * Where each demo branch is, so "nearest branch" (`POST /branches/nearest`) has
 * something to compare against. Neighbourhood-level, not surveyed.
 *
 * Backfilled onto branches that already exist: without coordinates a branch is
 * never chosen by location, and the whole feature falls back to the default with
 * no error — which reads as "location is broken", not "nobody placed the
 * branches".
 */
const BRANCH_COORDINATES: Record<string, { latitude: number; longitude: number }> = {
  'فرع دمشق - المزة': { latitude: 33.5, longitude: 36.25 },
  'فرع دمشق - أبو رمانة': { latitude: 33.5178, longitude: 36.2823 },
  'فرع دمشق - المالكي': { latitude: 33.523, longitude: 36.279 },
  'فرع حلب - الفرقان': { latitude: 36.21, longitude: 37.135 },
  'فرع حلب - الجميلية': { latitude: 36.212, longitude: 37.144 },
  'فرع حلب - الشهباء': { latitude: 36.23, longitude: 37.11 },
  'فرع حمص - الوعر': { latitude: 34.73, longitude: 36.67 },
  'فرع حمص - الإنشاءات': { latitude: 34.74, longitude: 36.715 },
  'فرع اللاذقية - الزراعة': { latitude: 35.52, longitude: 35.78 },
  'فرع اللاذقية - الشيخ ضاهر': { latitude: 35.529, longitude: 35.785 },
  'فرع طرطوس - الكورنيش': { latitude: 34.889, longitude: 35.883 },
  'فرع درعا - المركز': { latitude: 32.625, longitude: 36.105 },
  'فرع دير الزور - الجورة': { latitude: 35.335, longitude: 40.145 },
  'فرع الحسكة - المركز': { latitude: 36.5, longitude: 40.75 },
  'فرع السويداء - المركز': { latitude: 32.709, longitude: 36.566 },
};

// ── Users — generated from name pools so the list stays large without being
// unreadable; each entry still resolves to one deterministic definition. ──

interface UserSeed {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  role: string;
  branchIndex: number | null;
  ownership_percentage?: number;
  after?: 'suspend' | 'disable';
}

const FIRST_NAMES_M = [
  'محمد', 'خالد', 'عمر', 'أحمد', 'ياسر', 'زياد', 'باسل', 'حسام', 'أنس', 'مازن',
  'إياد', 'طارق', 'كنان', 'فراس', 'وسيم', 'سامر', 'عدنان', 'نضال', 'رامي', 'غسان',
];
const FIRST_NAMES_F = [
  'فاطمة', 'سارة', 'ليلى', 'رنا', 'هدى', 'نور', 'ريم', 'وفاء', 'منى', 'جود',
  'رهف', 'ديمة', 'لبنى', 'رغد', 'دانا', 'شذى', 'مايا', 'دينا', 'علا', 'إيمان',
];
const LAST_NAMES = [
  'الأحمد', 'الحسن', 'العلي', 'إبراهيم', 'الخطيب', 'الشامي', 'النجار', 'يوسف',
  'قاسم', 'مراد', 'حداد', 'دياب', 'سلامة', 'كنعان', 'الحلبي', 'فارس', 'عبدو',
  'شاهين', 'الدروبي', 'المصري', 'الحوراني', 'رستم', 'برازي', 'زيدان', 'الرفاعي',
  'نعمان', 'قنواتي', 'صالح', 'حمدان', 'شعبان', 'زيتون', 'برهوم', 'العبدالله',
  'قدور',
];

/**
 * Deterministic phone generator — avoids collisions without external state.
 * Must always produce exactly 10 digits starting "09" (see
 * core/validation/common-schemas.ts syrianPhoneSchema): "09" + 1-digit
 * carrier digit + 7-digit suffix = 10.
 */
function phoneFor(index: number): string {
  const carrierDigit = 3 + (Math.floor(index / 9_000_000) % 7); // 09[3-9]...
  const suffix = (1_000_000 + index * 37) % 9_000_000;
  return `09${carrierDigit}${String(suffix).padStart(6, '0')}`;
}

const ROLE_CYCLE = [
  ROLE.branchManager,
  ROLE.cashier,
  ROLE.inventoryStaff,
  ROLE.customerService,
  ROLE.printStaff,
  ROLE.customizationStaff,
  ROLE.deliveryStaff,
  ROLE.cashier,
  ROLE.inventoryStaff,
];

/**
 * Generates `count` active-track users, cycling through roles/branches so
 * every role and every branch gets realistic representation, with a fixed
 * proportion diverted to `suspend`/`disable` afterward for status-filter
 * variety (~1 in 7 → suspended, ~1 in 9 → disabled).
 */
function generateActiveUsers(count: number, branchCount: number): UserSeed[] {
  const users: UserSeed[] = [];
  for (let i = 0; i < count; i++) {
    const isFemale = i % 2 === 0;
    const firstPool = isFemale ? FIRST_NAMES_F : FIRST_NAMES_M;
    const first_name = firstPool[i % firstPool.length]!;
    const last_name = LAST_NAMES[(i * 7 + 3) % LAST_NAMES.length]!;
    const role = ROLE_CYCLE[i % ROLE_CYCLE.length]!;
    const branchIndex = i % branchCount;
    const email = `demo.user${i + 1}${DEMO_EMAIL_SUFFIX}`;

    const seed: UserSeed = {
      first_name,
      last_name,
      email,
      phone: phoneFor(i),
      role,
      branchIndex,
    };
    if (i % 7 === 6) seed.after = 'suspend';
    else if (i % 9 === 8) seed.after = 'disable';
    users.push(seed);
  }
  return users;
}

/** Hand-picked users kept as named, memorable individuals (not generated) —
 * cover the roles/scenarios the generated pool doesn't hit deterministically:
 * auditors, financial partners with ownership, and a branch-less auditor. */
const NAMED_USER_DEFS: UserSeed[] = [
  { first_name: 'زياد', last_name: 'سلامة', email: `ziad.salama${DEMO_EMAIL_SUFFIX}`, phone: '0934444555', role: ROLE.auditor, branchIndex: null },
  { first_name: 'مايا', last_name: 'رستم', email: `maya.rustom${DEMO_EMAIL_SUFFIX}`, phone: '0934001444', role: ROLE.auditor, branchIndex: null },
  { first_name: 'سامر', last_name: 'حداد', email: `samer.haddad${DEMO_EMAIL_SUFFIX}`, phone: '0934222333', role: ROLE.financialPartner, branchIndex: 6, ownership_percentage: 15 },
  { first_name: 'وسيم', last_name: 'برازي', email: `waseem.barazi${DEMO_EMAIL_SUFFIX}`, phone: '0934001555', role: ROLE.financialPartner, branchIndex: 11, ownership_percentage: 10 },
];

const ACTIVE_USER_DEFS: UserSeed[] = [
  ...NAMED_USER_DEFS,
  ...generateActiveUsers(56, BRANCH_DEFS.length),
];

interface PendingUserDef {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  requestedRole: string;
  branchIndex: number;
  reject?: boolean;
}

const PENDING_USER_DEFS: PendingUserDef[] = [
  { first_name: 'كريم', last_name: 'زيدان', email: `karim.zaidan${DEMO_EMAIL_SUFFIX}`, phone: '0935111222', requestedRole: ROLE.cashier, branchIndex: 0 },
  { first_name: 'دانا', last_name: 'شاهين', email: `dana.shahin${DEMO_EMAIL_SUFFIX}`, phone: '0935222333', requestedRole: ROLE.customerService, branchIndex: 1, reject: true },
  { first_name: 'عدنان', last_name: 'الرفاعي', email: `adnan.rifai${DEMO_EMAIL_SUFFIX}`, phone: '0935333444', requestedRole: ROLE.deliveryStaff, branchIndex: 3 },
  { first_name: 'شذى', last_name: 'نعمان', email: `shatha.noaman${DEMO_EMAIL_SUFFIX}`, phone: '0935444555', requestedRole: ROLE.inventoryStaff, branchIndex: 6 },
  { first_name: 'مازن', last_name: 'قنواتي', email: `mazen.qanawati${DEMO_EMAIL_SUFFIX}`, phone: '0935555666', requestedRole: ROLE.printStaff, branchIndex: 4, reject: true },
  { first_name: 'إيمان', last_name: 'العبدالله', email: `eman.abdullah${DEMO_EMAIL_SUFFIX}`, phone: '0935666777', requestedRole: ROLE.customerService, branchIndex: 8 },
  { first_name: 'نضال', last_name: 'حمدان', email: `nidal.hamdan${DEMO_EMAIL_SUFFIX}`, phone: '0935777888', requestedRole: ROLE.cashier, branchIndex: 10 },
];

// ── Actor / reset / ensure helpers ──────────────────────────────────────────

/**
 * The services now audit every mutation, and auditing needs an actor. This
 * script runs outside any HTTP request, so it forges one: a real `userId` (the
 * FK on audit_log_entries is NOT NULL), and nulls for the request-shaped
 * fields because there genuinely was no request.
 *
 * `device_info` names the script so seeded audit rows are distinguishable from
 * anything a human did — otherwise re-running the seed would bury real history
 * under hundreds of indistinguishable entries.
 */
function seedActor(userId: number): RequestActorContext {
  return {
    userId,
    ipAddress: null,
    deviceInfo: 'seed:demo-arabic-data',
    performedByRole: null,
    branchContext: null,
  };
}

async function findSystemActorId(): Promise<number> {
  // Any active is_admin account works as the "created by" actor for admin-direct
  // creation — the root-protected super admin bootstrapped for this environment.
  const rows = await usersRepository.findMany({ page: 1, limit: 1, offset: 0 }, {
    is_admin: true,
    sort_by: 'created_at',
    sort_dir: 'asc',
  });
  const admin = rows.rows[0];
  if (!admin) {
    throw new Error(
      'No admin user found — bootstrap the Super Admin first (`npm run db:seed -- --admin`, see bootstrap-super-admin.ts) before seeding demo data.',
    );
  }
  return admin.id;
}

/**
 * Real hard delete of every row this script owns. Deliberate, narrow
 * exception to the project's soft-delete convention — see file header.
 */
async function resetDemoData(): Promise<void> {
  const demoUserRows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.email, `%${DEMO_EMAIL_SUFFIX}`));
  const demoUserIds = demoUserRows.map((u) => u.id);

  if (demoUserIds.length > 0) {
    // audit_log_entries.user_id is RESTRICT — must clear before deleting users.
    await db.delete(auditLogEntriesTable).where(inArray(auditLogEntriesTable.user_id, demoUserIds));
    // user_role_assignments / ownerships / sessions are all CASCADE on user_id
    // (see schema files) — deleting the user rows removes them automatically.
    await db.delete(usersTable).where(inArray(usersTable.id, demoUserIds));
  }
  logger.info(`Reset: hard-deleted ${demoUserIds.length} previous demo user(s) (@qirtas.test)`);

  const demoBranchNames = BRANCH_DEFS.map((b) => b.name);
  const demoBranchRows = await db
    .select({ id: branchesTable.id })
    .from(branchesTable)
    .where(or(...demoBranchNames.map((name) => eq(branchesTable.name, name))));
  const demoBranchIds = demoBranchRows.map((b) => b.id);

  if (demoBranchIds.length > 0) {
    await db.delete(branchesTable).where(inArray(branchesTable.id, demoBranchIds));
  }
  logger.info(`Reset: hard-deleted ${demoBranchIds.length} previous demo branch(es)`);
}

async function ensureBranches(actor: RequestActorContext): Promise<number[]> {
  const { rows: existing } = await branchesRepository.findMany({ page: 1, limit: 200, offset: 0 }, {
    sort_by: 'created_at',
    sort_dir: 'asc',
  });
  const byName = new Map(existing.map((b) => [b.name, b] as const));

  const ids: number[] = [];
  for (const def of BRANCH_DEFS) {
    const found = byName.get(def.name);
    const where = BRANCH_COORDINATES[def.name];
    if (found && found.status !== 'closed') {
      // Backfill: a demo branch seeded before coordinates existed stays unplaced
      // forever otherwise, because this loop skips anything already present.
      if (where && found.latitude === null) {
        await branchesRepository.update(found.id, {
          latitude: where.latitude.toFixed(6),
          longitude: where.longitude.toFixed(6),
        });
        logger.info(`Placed branch on the map: ${found.name}`);
      }
      ids.push(found.id);
      continue;
    }
    const created = await branchesService.createBranch(actor, {
      name: def.name,
      address: def.address,
      contact_info: def.contact_info,
      ...(where ? where : {}),
    });
    if (def.status && def.status !== 'active') {
      await branchesService.updateBranch(actor, created.id, { status: def.status });
    }
    logger.info(`Created branch: ${created.name} (id ${created.id})`);
    ids.push(created.id);
  }
  return ids;
}

async function seedActiveUsers(actor: RequestActorContext, branchIds: number[]): Promise<void> {
  const { rows: roleRows } = await rolesRepository.findMany({ page: 1, limit: 50, offset: 0 }, {
    sort_by: 'created_at',
    sort_dir: 'desc',
  });
  const roleByName = new Map(roleRows.map((r) => [r.name, r] as const));

  let created = 0;
  let skipped = 0;
  for (const def of ACTIVE_USER_DEFS) {
    const existing = await usersRepository.findByEmail(def.email);
    if (existing) {
      skipped++;
      continue;
    }

    const role = roleByName.get(def.role);
    if (!role) {
      logger.error(`Missing expected system role "${def.role}" — skipping ${def.email}`);
      continue;
    }

    const branch_id = def.branchIndex === null ? null : branchIds[def.branchIndex];
    const row = await usersService.createUserByAdmin(actor, {
      first_name: def.first_name,
      last_name: def.last_name,
      email: def.email,
      phone: def.phone,
      password: DEMO_PASSWORD,
      role_id: role.id,
      branch_id,
      ...(def.ownership_percentage !== undefined
        ? { ownership_percentage: def.ownership_percentage }
        : {}),
    });
    created++;

    // Deliberate repository-level write, and the ONE place this script skips
    // the service layer.
    //
    // `suspendUser`/`disableUser` now enforce the "last qualified staff" guard
    // (production_readiness.md §A2), and several of these demo people ARE the
    // only holder of their role in their branch — so the services would, quite
    // correctly, refuse. But those refused states are precisely the fixture we
    // want: a branch that looks staffed while nobody in it can work is the
    // condition the dashboard's signals exist to surface, and a signal that
    // never meets its own condition has never been tested.
    //
    // Going through the service instead would silently produce a tidy dataset
    // with no defects in it — which is the opposite of this script's purpose.
    if (def.after === 'suspend' || def.after === 'disable') {
      await usersRepository.update(row.id, {
        status: def.after === 'suspend' ? 'suspended' : 'disabled',
      });
    }
  }
  logger.info(`Active-track users: created ${created}, skipped (already existed) ${skipped}`);
}

async function seedPendingUsers(actor: RequestActorContext, branchIds: number[]): Promise<void> {
  const { rows: roleRows } = await rolesRepository.findMany({ page: 1, limit: 50, offset: 0 }, {
    sort_by: 'created_at',
    sort_dir: 'desc',
  });
  const roleByName = new Map(roleRows.map((r) => [r.name, r] as const));

  let created = 0;
  let skipped = 0;
  for (const def of PENDING_USER_DEFS) {
    const existing = await usersRepository.findByEmail(def.email);
    if (existing) {
      skipped++;
      continue;
    }

    const role = roleByName.get(def.requestedRole);
    if (!role) {
      logger.error(`Missing expected system role "${def.requestedRole}" — skipping ${def.email}`);
      continue;
    }

    // Registration hands back a full sign-in result now; the seed wants the row
    // only — the session it issued is never used and expires unnoticed.
    const { user: row } = await usersService.registerStaff(
      {
        first_name: def.first_name,
        last_name: def.last_name,
        email: def.email,
        phone: def.phone,
        password: DEMO_PASSWORD,
        requested_role_id: role.id,
        requested_branch_id: branchIds[def.branchIndex],
      },
      // Seeding has no HTTP request behind it. `lang` only picks the wording of
      // a verification email that never leaves this process: `seed.ts` composes
      // the auth engine with a transport that reports `no_transport`, and the
      // accounts are marked verified below anyway.
      { ipAddress: null, deviceInfo: 'seed:demo-arabic-data', lang: 'ar' },
    );
    created++;

    // Demo staff land verified so the seeded dataset keeps describing the
    // situations it was built to expose — branches without managers, disabled
    // holders occupying roles. With verification enforced they would all sit at
    // `pending_verification`, never reach the review queue, and the dashboard
    // signals would have nothing to find (production_readiness.md §0: the seed
    // is a live test case, not data to be cleaned).
    await usersRepository.update(row.id, {
      email_verified_at: new Date(),
      ...(row.status === 'pending_verification' ? { status: 'pending_approval' as const } : {}),
    });

    if (def.reject) {
      await usersService.decideRegistration(actor, row.id, {
        decision: 'reject',
        reason: 'بيانات غير مكتملة - سجل تجريبي',
      });
    }
  }
  logger.info(`Pending-track users: created ${created}, skipped (already existed) ${skipped}`);
}

export interface SeedDemoArabicDataOptions {
  /** Hard-delete every row this script owns before re-seeding — see file header. */
  reset: boolean;
}

export async function seedDemoArabicData({ reset }: SeedDemoArabicDataOptions): Promise<void> {
  if (reset) {
    await resetDemoData();
  }

  const actor = seedActor(await findSystemActorId());
  const branchIds = await ensureBranches(actor);
  await seedActiveUsers(actor, branchIds);
  await seedPendingUsers(actor, branchIds);

  logger.info(
    `Demo Arabic data seed complete — ${BRANCH_DEFS.length} branches, ${ACTIVE_USER_DEFS.length + PENDING_USER_DEFS.length} users targeted.`,
  );
}
