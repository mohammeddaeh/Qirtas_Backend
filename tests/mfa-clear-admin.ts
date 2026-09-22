/**
 * Clears the seeded super admin's second factor from the DEV database, after
 * `tests/mfa.e2e.mjs` (which leaves it enrolled and locked on purpose — a
 * required role cannot opt out through the API).
 */
import { db } from '../src/core/db/client.js';
import { accountMfaTable, accountMfaRecoveryCodesTable } from '../src/core/auth/schemas/mfa.schema.js';
import { eq } from 'drizzle-orm';

await db.delete(accountMfaRecoveryCodesTable).where(eq(accountMfaRecoveryCodesTable.realm, 'staff'));
await db.delete(accountMfaTable).where(eq(accountMfaTable.realm, 'staff'));
console.log('staff second factors cleared');
process.exit(0);
