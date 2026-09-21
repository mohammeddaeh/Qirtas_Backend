import type { AuthRealm } from '../../core/auth/realm.js';
import {
  customerSessionsTable,
  customerVerificationTokensTable,
} from './schemas/customers.schema.js';
import { customerAccountStore } from './repositories/account-store.impl.js';

/**
 * The customer population as an auth realm.
 *
 * The `c_` prefix is what lets the auth middleware send a customer token to the
 * customer sessions table without probing staff's first — and it is part of the
 * hashed value, so rewriting the prefix on a stolen token yields nothing.
 */
export const customerAuthRealm: AuthRealm = {
  id: 'customer',
  store: customerAccountStore,
  sessions: customerSessionsTable,
  tokens: customerVerificationTokensTable,
  tokenPrefix: 'c_',
};
