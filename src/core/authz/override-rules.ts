/**
 * Rules for who may write permission overrides onto whom. Kept free of database
 * imports so they are unit-testable; `overrides.service.ts` gathers the facts.
 */

import { ForbiddenError } from '../http/api-error.js';

export interface OverrideRefusal {
  key:
    | 'user_root_protected'
    | 'override_target_outranks_actor'
    | 'override_target_not_active'
    | 'override_key_not_held';
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Who may write exceptions onto whom — the rules `users.access` alone never
 * carried.
 *
 * The route was guarded by one key and the service checked only self-lockout,
 * so anyone holding `users.access` could:
 * - allow **themselves** any key (`permissions.manage`, `users.delete`…);
 * - deny the root super admin the keys that run the system;
 * - hand permissions to a `pending_approval` or `rejected` account, which
 *   already holds a session — the only thing keeping it powerless was having no
 *   assignment, and an `allow` needs none. Approval, skipped.
 *
 * Four rules close those three, each mirroring one that already exists
 * elsewhere rather than inventing a policy:
 * 1. **Root-protected accounts are not edited** — as suspend/disable/archive
 *    already refuse, whoever asks.
 * 2. **The actor must outrank the target** when the target holds authority —
 *    the level rule role assignment enforces (`assertActorOutranksRole`).
 *    Acting on oneself is exempt: rule 4 is what bounds that.
 * 3. **No new allow on an account that is not `active`.** Denies stay
 *    possible: narrowing is never an escalation.
 * 4. **An actor grants only keys they hold** — nobody hands out a key they
 *    could not use themselves.
 *
 * Rules 3 and 4 judge only allows **added by this request**. The screen sends
 * the whole set (PUT), so an allow granted earlier by someone with more
 * authority comes back unchanged — refusing it would make that account
 * uneditable by anyone below its grantor, over rows this actor did not touch.
 *
 * Pure, so the rules are testable without a database.
 */
export function overrideRefusal(input: {
  actorUserId: number;
  target: { id: number; status: string; isRootProtected: boolean };
  actorKeys: readonly string[];
  actorLevel: number | null;
  targetLevel: number | null;
  existing: ReadonlyArray<{ permission_key: string; effect: 'allow' | 'deny' }>;
  requested: ReadonlyArray<{ key: string; effect: 'allow' | 'deny' }>;
}): OverrideRefusal | null {
  const { actorUserId, target, actorKeys, actorLevel, targetLevel, existing, requested } = input;
  const isSelf = actorUserId === target.id;

  if (target.isRootProtected && !isSelf) {
    return {
      key: 'user_root_protected',
      message: 'This account is root-protected and cannot be modified',
    };
  }

  // Lower number = more authority; `null` = none. An actor without authority
  // does not outrank anyone who has some.
  if (!isSelf && targetLevel !== null && (actorLevel === null || actorLevel >= targetLevel)) {
    return {
      key: 'override_target_outranks_actor',
      message: 'Cannot change the permissions of an account at or above your own authority level',
    };
  }

  const alreadyAllowed = new Set(
    existing.filter((o) => o.effect === 'allow').map((o) => o.permission_key),
  );
  const added = requested
    .filter((o) => o.effect === 'allow' && !alreadyAllowed.has(o.key))
    .map((o) => o.key);
  if (added.length === 0) return null;

  if (target.status !== 'active') {
    return {
      key: 'override_target_not_active',
      message: 'Permissions can only be granted to an active account',
      data: { status: target.status },
    };
  }

  const held = new Set(actorKeys);
  const notHeld = added.filter((key) => !held.has(key));
  if (notHeld.length > 0) {
    return {
      key: 'override_key_not_held',
      message: `You cannot grant a permission you do not hold: ${notHeld.join(', ')}`,
      data: { keys: notHeld },
    };
  }

  return null;
}

/**
 * Throws the refusal, if any — one `throw` per key, each naming its key
 * literally so `npm run check:messages` can see that every one is translated.
 */
export function assertOverrideAllowed(input: Parameters<typeof overrideRefusal>[0]): void {
  const r = overrideRefusal(input);
  if (!r) return;
  switch (r.key) {
    case 'user_root_protected':
      throw new ForbiddenError(r.message, r.data, 'user_root_protected');
    case 'override_target_outranks_actor':
      throw new ForbiddenError(r.message, r.data, 'override_target_outranks_actor');
    case 'override_target_not_active':
      throw new ForbiddenError(r.message, r.data, 'override_target_not_active');
    case 'override_key_not_held':
      throw new ForbiddenError(r.message, r.data, 'override_key_not_held');
  }
}
