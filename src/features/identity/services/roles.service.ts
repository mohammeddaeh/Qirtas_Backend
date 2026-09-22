import { NotFoundError, BusinessError, ForbiddenError } from '../../../core/http/api-error.js';
import {
  paginated,
  type PaginationParams,
  type Paginated,
} from '../../../core/pagination/pagination.js';
import * as rolesRepository from '../repositories/roles.repository.js';
import * as userRoleAssignmentsRepository from '../repositories/user-role-assignments.repository.js';
import * as permissionsService from './permissions.service.js';
import * as auditService from './audit.service.js';
import type { RequestActorContext } from './audit.service.js';
import { canGrantRoleLevel } from '../authority-level.js';
import { AUDIT, target } from './audit-actions.js';
import {
  toWireRole,
  type WireRole,
  type CreateRoleBody,
  type UpdateRoleBody,
  type UpdateRolePermissionsBody,
  type RolesFilterQuery,
  type WireRoleHolder,
  toWireRoleHolder,
} from '../dtos/roles.dto.js';
import { toWirePermission } from '../dtos/permissions.dto.js';

export const SUPER_ADMIN_ROLE_NAME = 'المدير العام';
/** Soft cap — informational only, never blocks creation (users_roles.md, 2026-07-09). */
const ROLE_SOFT_CAP = 25;

export async function listRoles(
  params: PaginationParams,
  filter: RolesFilterQuery,
  /** Required only when `filter.assignable` is set — see the filter's doc. */
  actorUserId?: number,
): Promise<Paginated<WireRole>> {
  // Resolved here, not in the repository: the level lives behind the
  // assignments repository, and the guard this mirrors reads it the same way.
  const actorLevel =
    filter.assignable === true && actorUserId !== undefined
      ? await userRoleAssignmentsRepository.findHighestAuthorityLevel(actorUserId)
      : undefined;

  const { rows, total } = await rolesRepository.findMany(params, filter, actorLevel);
  return paginated(
    rows.map((r) => toWireRole(r)),
    total,
    params,
  );
}

/**
 * The role catalog a self-registering visitor picks from — the ONLY roles
 * endpoint reachable without a session.
 *
 * Registration needs this list and has no session to read `GET /roles` with:
 * the form is filled in before an account exists, and `requested_role_id` is
 * required. Without a public catalog the picker on the register screen was
 * permanently empty, so the form could never be completed at all.
 *
 * Sends the same `WireRole` shape as every other roles endpoint rather than a
 * trimmed one — one wire shape, one client model, one picker. What the roles
 * can DO stays private either way: `permissions` is omitted here exactly as it
 * is on `GET /roles`, and `GET /permissions` remains gated.
 */
export async function listSelfRegisterableRoles(): Promise<WireRole[]> {
  const rows = await rolesRepository.findSelfRegisterable();
  return rows.map((r) => toWireRole(r));
}

export async function getRoleById(id: number): Promise<WireRole> {
  const row = await rolesRepository.findById(id);
  if (!row) throw new NotFoundError('Role not found');
  const [permissions, holders, assignmentsEver, openAssignments] = await Promise.all([
    rolesRepository.findPermissionsByRole(id),
    userRoleAssignmentsRepository.countActiveHoldersOfRole(id),
    rolesRepository.countAllAssignmentsEver(id),
    userRoleAssignmentsRepository.countOpenForRole(id),
  ]);
  return toWireRole(row, {
    permissions: permissions.map(toWirePermission),
    active_holders_count: holders,
    is_deletable: !row.is_system_default && assignmentsEver === 0,
    // Same rule `archiveRole` enforces. An already-archived role reports false
    // so the client shows "restore" rather than a second archive button.
    is_archivable: !row.is_system_default && row.archived_at === null && openAssignments === 0,
    assignments_ever_count: assignmentsEver,
    open_assignments_count: openAssignments,
  });
}

/** The people holding this role right now — one row per active assignment. */
export async function listRoleHolders(
  roleId: number,
  params: PaginationParams,
): Promise<Paginated<WireRoleHolder>> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');
  const { rows, total } = await rolesRepository.findHolders(roleId, params);
  return paginated(rows.map(toWireRoleHolder), total, params);
}

/**
 * Hard-deletes a role — the ONE case where this project deletes anything.
 *
 * The rule everywhere else is that nothing is destroyed, only retired, because
 * a record someone once held must stay readable. A role that **no assignment
 * has ever referenced** carries no such history: nobody ever was it, so there
 * is nothing to preserve and a permanently-retired row is just clutter in every
 * picker and filter forever.
 *
 * "Nobody holds it now" is NOT the condition — that is what deactivation is
 * for. `user_role_assignments.role_id` is `ON DELETE RESTRICT`, so the database
 * would refuse regardless; this check exists so the refusal arrives as a
 * sentence naming the reason rather than a raw constraint error.
 *
 * Seeded defaults are excluded outright: the next `db:seed` recreates them, so
 * deleting one is a no-op that looks like it worked.
 */
export async function deleteRole(actor: RequestActorContext, roleId: number): Promise<void> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  if (role.is_system_default) {
    throw new ForbiddenError(
      'A system-default role cannot be deleted — re-seeding would recreate it',
      undefined,
      'role_system_default_undeletable',
    );
  }

  await assertActorOutranks(actor.userId, role.level);

  const assignmentsEver = await rolesRepository.countAllAssignmentsEver(roleId);
  if (assignmentsEver > 0) {
    throw new BusinessError(
      409,
      `This role has ${assignmentsEver} assignment(s) in its history. Deactivate it instead — deleting would erase what those people once were.`,
      'role_has_history',
    );
  }

  // Recorded BEFORE the delete: afterwards there is no row to describe, and the
  // whole value of this entry is that it names what disappeared.
  await auditService.record(
    actor,
    AUDIT.roleDelete,
    target.role(roleId),
    {
      name: role.name,
      category: role.category,
      level: role.level,
    },
    null,
  );

  await rolesRepository.deleteById(roleId);
}

/**
 * Retires a role that HAS been held — off every list, out of every picker, and
 * still resolvable by everything that points at it.
 *
 * The exit [deleteRole] structurally cannot give. Its bar is "no assignment has
 * EVER referenced this", which is true only of a role created and never used;
 * every job title the organisation actually retired fails it, because those
 * closed assignment rows are what "أحمد was a cashier until March" is made of.
 * So the roles list accumulated finished roles permanently, and deactivating
 * them only moved them to the list's other tab.
 *
 * The bar here is "nobody holds it NOW" — open assignment rows, whatever the
 * holder's account status. A suspended employee still occupies the post, and
 * archiving under them would leave a live assignment granting permissions
 * through a role no screen in the app displays.
 *
 * `assertActorOutranks` for the same reason `deleteRole` and `reactivateRole`
 * use it: removing a high-authority role from circulation is an act on that
 * authority, and answers to the same bar as creating it.
 */
export async function archiveRole(actor: RequestActorContext, roleId: number): Promise<WireRole> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  // Idempotent rather than a 409 — the caller's intent already holds.
  if (role.archived_at !== null) return getRoleById(roleId);

  if (role.is_system_default) {
    throw new ForbiddenError(
      'A system-default role cannot be archived — re-seeding keeps it in the catalogue',
      undefined,
      'role_system_default_unarchivable',
    );
  }

  await assertActorOutranks(actor.userId, role.level);

  const openAssignments = await userRoleAssignmentsRepository.countOpenForRole(roleId);
  if (openAssignments > 0) {
    throw new BusinessError(
      409,
      `${openAssignments} assignment(s) still hold this role. End or transfer them before archiving it.`,
      'role_has_active_holders',
    );
  }

  const row = await rolesRepository.setArchivedAt(roleId, new Date());
  if (!row) throw new NotFoundError('Role not found');

  await auditService.record(
    actor,
    AUDIT.roleArchive,
    target.role(roleId),
    { name: role.name, archived_at: null },
    { name: row.name, archived_at: row.archived_at?.toISOString() ?? null },
  );

  return getRoleById(roleId);
}

/**
 * Puts an archived role back in the catalogue.
 *
 * `is_active` is untouched: archiving never changed it, so restoring must not
 * either. A role that was deactivated before it was archived comes back
 * deactivated — which is what it was — and reactivating it stays the separate,
 * announced decision it already is.
 */
export async function unarchiveRole(actor: RequestActorContext, roleId: number): Promise<WireRole> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');
  if (role.archived_at === null) return getRoleById(roleId);

  await assertActorOutranks(actor.userId, role.level);

  const row = await rolesRepository.setArchivedAt(roleId, null);
  if (!row) throw new NotFoundError('Role not found');

  await auditService.record(
    actor,
    AUDIT.roleUnarchive,
    target.role(roleId),
    { archived_at: role.archived_at.toISOString() },
    { archived_at: null },
  );

  return getRoleById(roleId);
}

/**
 * Refuses every write to an archived role — one guard, applied at each entry.
 *
 * Editing a role the app shows nowhere is not a coherent request: the result
 * cannot be reviewed, and the most dangerous version of it — reactivating an
 * archived role, or widening its permissions — would put an invisible role back
 * into effect. Restore first, then edit, so the change lands somewhere a person
 * can see it.
 */
function assertNotArchived(role: { archived_at: Date | null }): void {
  if (role.archived_at === null) return;
  throw new BusinessError(409, 'This role is archived. Restore it before editing.', 'role_archived');
}

/**
 * Privilege-escalation guard: an actor cannot create/edit a role at a level
 * equal to or higher (numerically lower-or-equal) than their own
 * highest-authority level — `canGrantRoleLevel`, the same rule assignment uses.
 *
 * Actors with no level used to be exempt ("nothing to escalate from yet"), but
 * no path without an actor reaches here — bootstrap inserts directly — so the
 * exemption only ever served someone holding `roles.edit` on a level-less role,
 * who could then create a level-0 role.
 */
async function assertActorOutranks(actorUserId: number, targetLevel: number | null): Promise<void> {
  if (targetLevel === null) return; // Auditor-style roles carry no authority level to compare against.
  const actorLevel = await userRoleAssignmentsRepository.findHighestAuthorityLevel(actorUserId);
  if (!canGrantRoleLevel(actorLevel, targetLevel)) {
    throw new ForbiddenError(
      'Cannot create or modify a role at or above your own authority level',
      undefined,
      'role_edit_above_actor_level',
    );
  }
}

/**
 * Refuses to put on a role any key the actor does not hold themselves — only
 * the keys **added** by this call are judged.
 *
 * Without it `roles.edit` was a master key: add `users.manage` (or anything)
 * to a role below you, assign that role to yourself (allowed — it is below
 * you), and you hold it. Same rule as per-account overrides
 * (`core/authz/override-rules.ts`): nobody hands out a key they could not use.
 * Keys already on the role pass untouched, or a role granted more by someone
 * senior would become uneditable by anyone below them.
 */
async function assertActorHoldsAddedKeys(
  actorUserId: number,
  requested: readonly string[],
  existing: readonly string[],
): Promise<void> {
  const already = new Set(existing);
  const added = requested.filter((key) => !already.has(key));
  if (added.length === 0) return;
  const held = new Set(await userRoleAssignmentsRepository.findAllEffectivePermissionKeys(actorUserId));
  const notHeld = added.filter((key) => !held.has(key));
  if (notHeld.length === 0) return;
  throw new ForbiddenError(
    `You cannot grant a permission you do not hold: ${notHeld.join(', ')}`,
    { keys: notHeld },
    'role_key_not_held',
  );
}

export async function createRole(
  actor: RequestActorContext,
  body: CreateRoleBody,
): Promise<WireRole> {
  const actorUserId = actor.userId;
  const existingByName = await rolesRepository.findByName(body.name);
  if (existingByName) {
    // Deliberately a DIFFERENT messageKey from the duplicate-permission-set
    // 409 below: both share a status code, but only that one is overridable
    // with `force`. The key is how a client tells them apart.
    throw new BusinessError(409, `Role name "${body.name}" is already in use`, 'role_name_taken');
  }

  let permissionKeys = body.permission_keys;
  let category = body.category;
  // An explicit level always wins over the clone source's: the caller who
  // typed one meant it, and silently overriding it with the source's would be
  // the surprise.
  let level: number | null = body.level ?? null;

  if (body.clone_from_role_id) {
    const source = await rolesRepository.findById(body.clone_from_role_id);
    if (!source) throw new NotFoundError('Source role to clone from was not found');
    const sourceKeys = await rolesRepository.findPermissionKeys(source.id);
    permissionKeys = permissionKeys.length > 0 ? permissionKeys : sourceKeys;
    category = category ?? source.category;
    level ??= source.level;
  }

  await assertActorOutranks(actorUserId, level);
  await permissionsService.assertPermissionKeysExist(permissionKeys);
  // A new role has nothing "already on it" — cloning included: copying a role
  // you could not have built is the same grant.
  await assertActorHoldsAddedKeys(actorUserId, permissionKeys, []);

  if (!body.force) {
    const duplicate = await rolesRepository.findActiveRoleIdWithExactPermissionSet(permissionKeys);
    if (duplicate !== undefined) {
      throw new BusinessError(
        409,
        `An active role (id ${duplicate}) already has this exact permission set. Pass force=true to create anyway.`,
        // Translated: an admin reads this mid-task. The English fallback keeps
        // the offending role id for logs; the translated text drops it because
        // a raw id means nothing to the reader.
        'role_duplicate_permission_set',
      );
    }
  }

  const row = await rolesRepository.insert({
    name: body.name,
    category,
    level,
    is_system_default: false,
    is_active: true,
  });
  await rolesRepository.insertPermissions(row.id, permissionKeys);
  const permissions = await rolesRepository.findPermissionsByRole(row.id);

  // Logged unconditionally, unlike updateRolePermissions which logs only when
  // a sensitive permission is touched: creating a role is the moment its whole
  // permission set comes into existence, so there is no prior state to compare
  // against and decide it was harmless.
  await auditService.record(actor, AUDIT.roleCreate, target.role(row.id), null, {
    name: row.name,
    category: row.category,
    level: row.level,
    permission_keys: permissionKeys,
    cloned_from_role_id: body.clone_from_role_id ?? null,
    forced: body.force === true,
  });

  return toWireRole(row, {
    permissions: permissions.map(toWirePermission),
    // A role that was created a line ago: nobody holds it, nothing has ever
    // referenced it. Stated rather than re-queried, since the four counts are
    // knowable from the fact of creation itself.
    active_holders_count: 0,
    is_deletable: !row.is_system_default,
    is_archivable: !row.is_system_default,
    assignments_ever_count: 0,
    open_assignments_count: 0,
  });
}

/**
 * Renames a role and/or moves it between categories.
 *
 * ── Why the Super Admin role cannot be renamed ─────────────────────────────
 * [SUPER_ADMIN_ROLE_NAME] is compared against `roles.name` as a plain string in
 * the guards that decide who may change a role's authority level and who counts
 * as the protected root account (`users.service.ts`). Renaming that one row
 * would not fail anywhere — it would quietly make every one of those lookups
 * return nothing, i.e. disable the checks rather than trip them. Nothing else
 * is name-addressed, so the other seeded roles rename freely.
 *
 * ── Why category is editable at all ────────────────────────────────────────
 * It decides whether the "last qualified staff" guard applies to a role's
 * assignments (`management`/`system` are guarded). Moving a role out of those
 * categories genuinely relaxes that protection — which is why this is audited
 * with both the old and new value, and why it needs `roles.edit` plus outranking
 * the role being edited.
 */
export async function updateRole(
  actor: RequestActorContext,
  roleId: number,
  body: UpdateRoleBody,
): Promise<WireRole> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  assertNotArchived(role);
  await assertActorOutranks(actor.userId, role.level);

  if (body.name !== undefined && body.name !== role.name) {
    if (role.name === SUPER_ADMIN_ROLE_NAME) {
      throw new ForbiddenError(
        'The Super Admin role cannot be renamed — core authority checks identify it by name',
        undefined,
        'super_admin_role_immutable',
      );
    }
    const existingByName = await rolesRepository.findByName(body.name);
    if (existingByName) {
      throw new BusinessError(409, `Role name "${body.name}" is already in use`, 'role_name_taken');
    }
  }

  const row = await rolesRepository.updateIdentity(roleId, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.category !== undefined ? { category: body.category } : {}),
  });
  if (!row) throw new NotFoundError('Role not found');

  await auditService.record(
    actor,
    AUDIT.roleUpdate,
    target.role(roleId),
    { name: role.name, category: role.category },
    { name: row.name, category: row.category },
  );

  // Re-read rather than assembled here: the response is what the detail screen
  // re-renders from, and it carries `is_deletable`/`is_archivable` — verdicts
  // this function has no business deriving a second time.
  return getRoleById(roleId);
}

/** True once the number of active roles exceeds the informational soft cap (never blocks creation). */
export async function isOverSoftCap(): Promise<boolean> {
  const activeCount = await rolesRepository.countActive();
  return activeCount > ROLE_SOFT_CAP;
}

export async function updateRolePermissions(
  actor: RequestActorContext,
  roleId: number,
  body: UpdateRolePermissionsBody,
): Promise<WireRole> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  assertNotArchived(role);
  await assertActorOutranks(actor.userId, role.level);
  await permissionsService.assertPermissionKeysExist(body.permission_keys);
  await assertActorHoldsAddedKeys(
    actor.userId,
    body.permission_keys,
    await rolesRepository.findPermissionKeys(roleId),
  );

  // The same role-explosion warning `createRole` raises, and for the same
  // reason: the rule is about the resulting STATE — two active roles with
  // identical powers and different names — not about which endpoint produced
  // it. Checking only on create meant a role could be cloned and saved
  // untouched, arriving at exactly the state the warning exists to question,
  // with nothing said. `excludeRoleId` keeps a role from matching itself.
  if (!body.force) {
    const duplicate = await rolesRepository.findActiveRoleIdWithExactPermissionSet(
      body.permission_keys,
      roleId,
    );
    if (duplicate !== undefined) {
      throw new BusinessError(
        409,
        `An active role (id ${duplicate}) already has this exact permission set. Pass force=true to save anyway.`,
        'role_duplicate_permission_set',
      );
    }
  }

  const previousKeys = await rolesRepository.findPermissionKeys(roleId);
  await rolesRepository.replacePermissions(roleId, body.permission_keys);

  const touchesSensitive =
    (await permissionsService.isAnySensitive(previousKeys)) ||
    (await permissionsService.isAnySensitive(body.permission_keys));
  if (touchesSensitive) {
    await auditService.record(
      actor,
      AUDIT.rolePermissionsUpdate,
      target.role(roleId),
      previousKeys,
      body.permission_keys,
    );
  }

  // Notify every currently-assigned user that their effective permissions changed (2026-07-09 decision).
  // Actual notification delivery is out of scope for this module (backlog.md #18) — this is the hook point.

  // Re-read for the same reason `updateRole` does — and here it also fixes an
  // existing slip: `role` is the row as it was BEFORE the write.
  return getRoleById(roleId);
}

/**
 * Level edits require Super Admin exclusively — a hard exception, not the
 * usual relative-level comparison (see users_roles.md, "سد ثغرة"): checking
 * against the actor's own level would let a Super-Admin-level actor raise
 * their own role's level right after the check runs. This looks up the
 * actor's active role assignments directly rather than trusting a caller-
 * supplied flag.
 */
export async function updateRoleLevel(
  actor: RequestActorContext,
  roleId: number,
  level: number,
): Promise<WireRole> {
  const isSuperAdmin = await actorHoldsSuperAdmin(actor.userId);
  if (!isSuperAdmin) {
    throw new ForbiddenError(
      "Only Super Admin can change a role's authority level",
      undefined,
      'role_level_super_admin_only',
    );
  }
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  assertNotArchived(role);

  const row = await rolesRepository.setLevel(roleId, level);
  if (!row) throw new NotFoundError('Role not found');

  // Authority level decides who may assign this role to whom — a change here
  // silently rewrites the privilege-escalation boundary for every future
  // assignment, so it is audited even though only Super Admin can reach it.
  await auditService.record(
    actor,
    AUDIT.roleLevelUpdate,
    target.role(roleId),
    { level: role.level },
    { level: row.level },
  );
  return toWireRole(row);
}

/**
 * Exported so `getCurrentUser` can report it on the wire: two operations are
 * gated on holding this role and no permission key expresses it, so a client
 * that cannot ask would either hide the control from the one person who needs
 * it or offer it to everyone and refuse them afterwards.
 */
export async function actorHoldsSuperAdmin(actorUserId: number): Promise<boolean> {
  const assignments = await userRoleAssignmentsRepository.findActiveForUser(actorUserId);
  if (assignments.length === 0) return false;
  const superAdminRole = await rolesRepository.findActiveByName(SUPER_ADMIN_ROLE_NAME);
  if (!superAdminRole) return false;
  return assignments.some((a) => a.role_id === superAdminRole.id);
}

export async function deactivateRole(
  actor: RequestActorContext,
  roleId: number,
): Promise<WireRole> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  assertNotArchived(role);

  if (role.name === SUPER_ADMIN_ROLE_NAME) {
    throw new ForbiddenError(
      'The Super Admin role can never be deactivated',
      undefined,
      'super_admin_role_undeactivatable',
    );
  }

  const hasActive = await rolesRepository.hasActiveAssignments(roleId);
  if (hasActive) {
    throw new BusinessError(
      409,
      'This role has active user assignments. Reassign every affected user to another role first.',

      'role_has_active_assignments',
    );
  }

  const row = await rolesRepository.setActive(roleId, false);
  if (!row) throw new NotFoundError('Role not found');
  await auditService.record(
    actor,
    AUDIT.roleDeactivate,
    target.role(roleId),
    { is_active: role.is_active },
    { is_active: row.is_active },
  );
  return toWireRole(row);
}

/**
 * Puts a deactivated role back into service.
 *
 * The counterpart to [deactivateRole], which shipped without one — a role could
 * be retired but never brought back, so a mistaken click was permanent and the
 * row simply vanished from every list. Deactivation was always meant to be the
 * reversible alternative to deletion; without this it was just a slower delete.
 *
 * [assertActorOutranks] is not ceremony here: reviving a high-authority role is
 * the same privilege grant as creating one, so it answers to the same bar. The
 * name-uniqueness index is global (not partial on `is_active`), so a dormant
 * name was never released and cannot collide on the way back.
 */
export async function reactivateRole(
  actor: RequestActorContext,
  roleId: number,
): Promise<WireRole> {
  const role = await rolesRepository.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  assertNotArchived(role);

  if (role.is_active) {
    throw new BusinessError(409, 'This role is already active', 'role_already_active');
  }

  await assertActorOutranks(actor.userId, role.level);

  const row = await rolesRepository.setActive(roleId, true);
  if (!row) throw new NotFoundError('Role not found');
  await auditService.record(
    actor,
    AUDIT.roleReactivate,
    target.role(roleId),
    { is_active: role.is_active },
    { is_active: row.is_active },
  );
  return toWireRole(row);
}
