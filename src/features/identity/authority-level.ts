/**
 * Whether an actor at [actorLevel] may hand out a role at [roleLevel].
 *
 * Lower number = more authority; `null` = none at all.
 *
 * - A role with no level carries no authority — anyone who may assign may
 *   assign it.
 * - A role with a level may be granted only by someone **strictly above** it.
 * - **An actor with no level grants no leveled role.** This used to be the
 *   opposite: `actorLevel === null` skipped the check entirely, so a role with
 *   `users.access` and no authority of its own could assign «المدير العام»
 *   (level 0) — to anyone, itself included. "No authority" was read as "no
 *   limit".
 *
 * One function, because the rule is enforced in several places (assignment,
 * transfer, admin-created accounts, registration approval) and the assignable
 * catalogue must show exactly what they accept. Every copy that disagreed
 * would be either a hole or a refusal the picker invited.
 */
export function canGrantRoleLevel(actorLevel: number | null, roleLevel: number | null): boolean {
  if (roleLevel === null) return true;
  if (actorLevel === null) return false;
  return roleLevel > actorLevel;
}
