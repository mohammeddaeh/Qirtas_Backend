import { ForbiddenError } from '../../http/api-error.js';
import { isEnforced, listEnforcedPermissions } from '../registry.js';
import * as overridesRepository from '../repositories/overrides.repository.js';

/**
 * Per-account exceptions — read and write.
 *
 * The rules that live here are the ones about *managing* exceptions. How a
 * permission resolves is `inference.ts`; who may call these is
 * `requirePermission` on the route.
 */

export interface WireOverride {
  key: string;
  effect: 'allow' | 'deny';
  note: string | null;
  /** `true` when no route enforces the key any more — shown, not hidden, so it gets cleaned up on purpose. */
  is_stale: boolean;
}

export interface WireUserOverrides {
  user_id: number;
  overrides: WireOverride[];
  /**
   * What the account ends up with — roles, plus allows, minus denies.
   *
   * Sent beside the exceptions because an administrator ticking boxes without
   * seeing the result is how a deny on `roles.view` quietly revokes a
   * `roles.edit` nobody meant to touch (see `inference.ts` rule 2). The screen
   * shows the choices and the outcome together, or it shows half the truth.
   */
  effective_permissions: string[];
}

/**
 * [effectivePermissions] must be the **already-resolved** set — what
 * `findAllEffectivePermissionKeys` returns.
 *
 * Passed in rather than recomputed here, deliberately: resolving a second time
 * would apply the overrides to a set they had already been applied to. That
 * happens to be harmless (removing a key twice removes it once), which is
 * exactly why it would have survived review and confused the next reader. One
 * resolution, one place.
 */
export async function getForUser(
  userId: number,
  effectivePermissions: string[],
): Promise<WireUserOverrides> {
  const rows = await overridesRepository.findForUser(userId);

  return {
    user_id: userId,
    overrides: rows
      .map((row) => ({
        key: row.permission_key,
        effect: row.effect,
        note: row.note,
        is_stale: !isEnforced(row.permission_key),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    effective_permissions: [...effectivePermissions].sort(),
  };
}

export async function replaceForUser(
  actorUserId: number,
  userId: number,
  overrides: Array<{ key: string; effect: 'allow' | 'deny'; note?: string | null }>,
): Promise<void> {
  assertNoSelfLockout(actorUserId, userId, overrides);
  await overridesRepository.replaceForUser(userId, overrides);
}

/**
 * Refuses a change that would deny the acting administrator the very permission
 * that lets them undo it.
 *
 * Checked **before** the write, because there is nothing to roll back to
 * afterwards — and an administrator who has just denied themselves
 * `users.manage` is the one person who cannot repair it.
 *
 * Only the two keys that gate this screen are protected, not every permission:
 * an administrator narrowing their own access deliberately is legitimate;
 * losing the ability to widen it again is not.
 */
const SELF_LOCKOUT_KEYS = ['users.access', 'roles.edit'];

function assertNoSelfLockout(
  actorUserId: number,
  userId: number,
  overrides: Array<{ key: string; effect: 'allow' | 'deny' }>,
): void {
  if (actorUserId !== userId) return;

  const denied = overrides
    .filter((o) => o.effect === 'deny')
    .map((o) => o.key)
    .filter((key) => SELF_LOCKOUT_KEYS.includes(key));

  if (denied.length === 0) return;

  throw new ForbiddenError(
    `You cannot deny yourself: ${denied.join(', ')}`,
    { keys: denied },
    'authz_self_lockout',
  );
}

/** Every key an override may name — the ones routes actually enforce. */
export function grantableKeys(): string[] {
  return listEnforcedPermissions().map((p) => p.key);
}
