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
// Authentication tables — moved out of features/identity 2026-08-11 because
// they belong to the reusable engine, not to Qirtas's user model. See
// core/auth/schemas/sessions.schema.ts for the full reasoning.
export * from '../auth/schemas/sessions.schema.js';
export * from '../auth/schemas/verification-tokens.schema.js';
export * from '../../features/localization/schemas/languages.schema.js';
export * from '../../features/localization/schemas/translation-entries.schema.js';

// Staging for two-phase imports. Owned by core/data-transfer/ and shared by
// every resource — see its own doc for why a table rather than a Map.
export * from '../data-transfer/schemas/import-staging.schema.js';
