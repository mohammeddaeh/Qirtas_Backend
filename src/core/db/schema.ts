/**
 * Drizzle schema barrel.
 * Every feature's `schemas/*.schema.ts` MUST be re-exported here — drizzle-kit
 * only reads this one file to discover tables. See src/core/CLAUDE.md.
 *
 * NOTE: run drizzle-kit via `npm run db:generate`/`db:migrate`/`db:push` (they
 * invoke it through tsx — see package.json), never `npx drizzle-kit` directly.
 * drizzle-kit's own CJS loader cannot resolve `.js`-suffixed relative imports
 * (required everywhere else by NodeNext + tsx at runtime); running it through
 * tsx resolves that mismatch without needing an extension-less exception here.
 */
export * from '../../features/identity/schemas/branches.schema.js';
export * from '../../features/identity/schemas/roles.schema.js';
export * from '../../features/identity/schemas/permissions.schema.js';
export * from '../../features/identity/schemas/role-permissions.schema.js';
export * from '../../features/identity/schemas/users.schema.js';
export * from '../../features/identity/schemas/user-role-assignments.schema.js';
export * from '../../features/identity/schemas/ownerships.schema.js';
export * from '../../features/identity/schemas/audit-log-entries.schema.js';
export * from '../../features/identity/schemas/sessions.schema.js';
