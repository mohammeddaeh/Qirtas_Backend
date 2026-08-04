/**
 * The complete catalogue of audited actions.
 *
 * One place, so the set is discoverable and a typo cannot silently create a
 * parallel action name that no query will ever find. `action` is a varchar in
 * the table, not an enum — the constraint is this file, by convention.
 *
 * Naming: `<entity>.<verb>`, dotted, past-tense-free. `target_entity` is
 * written separately as `<entity>:<id>` so the audit log can be filtered by a
 * single record's whole history regardless of which action touched it.
 *
 * See docs/production_readiness.md §C1 for why this exists: before 2026-08-04
 * exactly one mutation in the system was audited, so "who disabled this
 * account?" had no answer. An audit gap cannot be filled retroactively.
 */
export const AUDIT = {
  // — Accounts —
  userCreate: 'user.create',
  userUpdate: 'user.update',
  userSuspend: 'user.suspend',
  userDisable: 'user.disable',
  userReactivate: 'user.reactivate',
  userRegistrationDecide: 'user.registration.decide',

  // — Assignments (where a person actually sits) —
  assignmentCreate: 'assignment.create',
  assignmentTransfer: 'assignment.transfer',
  assignmentEnd: 'assignment.end',

  // — Branches —
  branchCreate: 'branch.create',
  branchUpdate: 'branch.update',

  // — Roles —
  roleCreate: 'role.create',
  roleDeactivate: 'role.deactivate',
  roleLevelUpdate: 'role.level.update',
  rolePermissionsUpdate: 'role.permissions.update',
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

/** `user:12`, `branch:3`, … — the filterable identity of the touched record. */
export const target = {
  user: (id: number) => `user:${id}`,
  branch: (id: number) => `branch:${id}`,
  role: (id: number) => `role:${id}`,
  assignment: (id: number) => `assignment:${id}`,
} as const;
