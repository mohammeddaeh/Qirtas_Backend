/**
 * **The one app-specific line in `core/auth/`.**
 *
 * `sessions` and `auth_verification_tokens` both need a foreign key to whatever
 * table holds accounts, and a foreign key must name a real table — so this is
 * the single place where the reusable engine touches the application's schema.
 *
 * ## Why it is a file and not just an import in each schema
 *
 * Without it, both schema files would import the application's table directly,
 * and porting the engine to another project would mean finding and retargeting
 * two imports — the sort of thing that is easy to half-do. Here the seam is
 * named, it is one line, and moving the engine is a single edit.
 *
 * ## What porting looks like
 *
 * Change the import below to point at the new application's account table, and
 * alias it to `accountsTable`. Nothing else under `core/auth/` changes:
 *
 * ```ts
 * export { usersTable as accountsTable } from '../../../features/account/schemas/users.schema.js';
 * ```
 *
 * ## Why the FK is kept rather than dropped for portability
 *
 * Dropping it would make this file unnecessary, at the cost of `ON DELETE
 * CASCADE`: a deleted account would leave its sessions and verification codes
 * behind as rows pointing at nobody. Live credentials outliving their owner is
 * a worse outcome than one line of per-application wiring.
 */
export { usersTable as accountsTable } from '../../../features/identity/schemas/users.schema.js';
