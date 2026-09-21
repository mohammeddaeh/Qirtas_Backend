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
  // — Authentication —
  // Not listed individually here: the names come from
  // `core/auth/ports/security-event-sink.ts` (AUTH_EVENT) and are written
  // through the adapter in `repositories/security-event-sink.impl.ts`.
  //
  // They live there rather than here because they belong to the authentication
  // engine, which is reusable across applications, while this catalogue is
  // Qirtas's. Both write to the same `action` column and share the
  // `<entity>.<verb>` convention, so a single query still returns the whole
  // history of a record regardless of which layer recorded it.

  // — Accounts —
  userCreate: 'user.create',
  userUpdate: 'user.update',
  userSuspend: 'user.suspend',
  userDisable: 'user.disable',
  userReactivate: 'user.reactivate',
  userRegistrationDecide: 'user.registration.decide',
  userArchive: 'user.archive',
  userUnarchive: 'user.unarchive',
  userDelete: 'user.delete',

  // — Customers (admin actions on a shopper's account) —
  customerSuspend: 'customer.suspend',
  customerDisable: 'customer.disable',
  customerReactivate: 'customer.reactivate',
  customerWholesaleDecide: 'customer.wholesale.decide',
  customerArchive: 'customer.archive',
  customerUnarchive: 'customer.unarchive',
  customerDelete: 'customer.delete',
  customerVerificationResend: 'customer.verification.resend',
  customerPasswordResetSend: 'customer.password_reset.send',

  // — Assignments (where a person actually sits) —
  assignmentCreate: 'assignment.create',
  assignmentTransfer: 'assignment.transfer',
  assignmentEnd: 'assignment.end',

  // — Branches —
  branchCreate: 'branch.create',
  branchUpdate: 'branch.update',
  branchArchive: 'branch.archive',
  branchUnarchive: 'branch.unarchive',
  branchDelete: 'branch.delete',

  // — Roles —
  roleCreate: 'role.create',
  roleUpdate: 'role.update',
  roleDelete: 'role.delete',
  roleArchive: 'role.archive',
  roleUnarchive: 'role.unarchive',
  roleDeactivate: 'role.deactivate',
  roleReactivate: 'role.reactivate',
  roleLevelUpdate: 'role.level.update',
  rolePermissionsUpdate: 'role.permissions.update',
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

/** `user:12`, `branch:3`, … — the filterable identity of the touched record. */
export const target = {
  user: (id: number) => `user:${id}`,
  branch: (id: number) => `branch:${id}`,
  customer: (id: number) => `customer:${id}`,
  role: (id: number) => `role:${id}`,
  assignment: (id: number) => `assignment:${id}`,
} as const;
