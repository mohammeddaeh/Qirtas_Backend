import type { AuthRealm } from '../../core/auth/realm.js';
import { sessionsTable } from '../../core/auth/schemas/sessions.schema.js';
import { verificationTokensTable } from '../../core/auth/schemas/verification-tokens.schema.js';
import { qirtasAccountStore } from './repositories/account-store.impl.js';

/**
 * The staff population (`users`) as an auth realm.
 *
 * Empty token prefix: staff tokens predate realms, so every live session keeps
 * working and no one signs in again because of this change.
 */
export const staffAuthRealm: AuthRealm = {
  id: 'staff',
  store: qirtasAccountStore,
  sessions: sessionsTable,
  tokens: verificationTokensTable,
  tokenPrefix: '',
};
