import { env } from '../../core/config/env.js';
import type { MfaPolicy } from '../../core/auth/mfa/mfa.service.js';
import * as assignmentsRepository from './repositories/user-role-assignments.repository.js';
import * as rolesRepository from './repositories/roles.repository.js';
import { SUPER_ADMIN_ROLE_NAME } from './services/roles.service.js';

/**
 * Who MUST hold a second factor: the two roles whose stolen password costs the
 * most — the Super Admin (everything) and the branch manager (wholesale
 * decisions, customer contact data, staff of a whole branch).
 *
 * By role NAME, like `actorHoldsSuperAdmin`: the seed defines these two by name
 * and the project already treats the name as the identity of the system roles.
 * Any active assignment counts — a person who manages one branch and works the
 * till in another is still a manager.
 */
export const MFA_REQUIRED_ROLE_NAMES = [SUPER_ADMIN_ROLE_NAME, 'مدير الفرع'] as const;

/** Whether the requirement is *forced* (see `MFA_ENFORCE`). **Off everywhere by default** — a deferred proposal (docs/reference/mfa.md), switched on by setting `MFA_ENFORCE=true`. */
export function mfaEnforced(): boolean {
  return env.MFA_ENFORCE ?? false;
}

export const identityMfaPolicy: MfaPolicy = {
  async isRequired(realm, accountId) {
    if (realm !== 'staff') return false;
    const assignments = await assignmentsRepository.findActiveForUser(accountId);
    if (assignments.length === 0) return false;
    const held = new Set(assignments.map((a) => a.role_id));
    for (const name of MFA_REQUIRED_ROLE_NAMES) {
      const role = await rolesRepository.findActiveByName(name);
      if (role && held.has(role.id)) return true;
    }
    return false;
  },
};
