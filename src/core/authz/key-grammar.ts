/**
 * The `module.action` convention, enforced instead of merely documented.
 *
 * `docs/reference/users_roles.md` and `permissions.schema.ts` both state the
 * rule ("module name always plural — `orders.create`, `inventory.view`"), and
 * until now nothing checked it. A key that does not parse is not a style
 * problem: the roles screen groups by module, the seed groups display names by
 * module, and a key with no module segment silently becomes a group of one
 * labelled with a raw string.
 *
 * Kept in its own file rather than inside `registry.ts` so the seed checker can
 * use it without importing anything that touches routes.
 */

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface ParsedKey {
  /** First segment — the module the roles screen groups by. */
  module: string;
  /**
   * Everything after the first dot, verbatim.
   *
   * Not just the second segment: Qirtas legitimately uses three-part keys
   * (`orders.delivery.update`, `customization.proof.approve`, and
   * `reports.financial.view`), where the middle segment names a sub-area. A
   * grammar that rejected them would reject working production keys, so the
   * rule is "one module, then at least one more segment" — not "exactly two".
   */
  action: string;
}

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function parseKey(key: string): ParsedKey {
  const firstDot = key.indexOf('.');
  return {
    module: key.slice(0, firstDot),
    action: key.slice(firstDot + 1),
  };
}
