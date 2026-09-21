import { describe, expect, it } from 'vitest';
import { toWireCustomer } from '../dtos/customers.dto.js';

/**
 * **The server half of the customer contract `qirtas_app` parses**
 * (`test/wire_contract_test.dart` · fixture `test/fixtures/wire/customer_login_data.json`).
 *
 * Same reasoning as `identity/__tests__/wire-contract.test.ts`: a JSON key is an
 * agreement nothing enforces. Here the failure is sharper — a customer response
 * missing `email_verified` reads as *unverified* on the client (a parse gap must
 * never grant the purchase tier), so a renamed key does not crash: every
 * verified customer silently loses the ability to buy.
 *
 * When this list changes, change the Flutter fixture in the same commit.
 */
const row = {
  id: 7,
  first_name: 'ليلى',
  last_name: 'حداد',
  email: 'laila@qirtas.test',
  phone: null,
  password_hash: 'x',
  email_verified_at: null,
  phone_verified_at: null,
  status: 'active' as const,
  customer_type: 'retail' as const,
  wholesale_status: null,
  wholesale_requested_at: null,
  wholesale_decided_at: null,
  wholesale_decided_by_user_id: null,
  wholesale_rejection_reason: null,
  preferred_branch_id: null,
  image: null,
  address: null,
  archived_at: null,
  created_at: new Date('2026-09-20T09:34:27.311Z'),
};

describe('WireCustomer', () => {
  it('carries exactly the keys the client reads', () => {
    expect(Object.keys(toWireCustomer(row)).sort()).toEqual(
      [
        'id',
        'first_name',
        'last_name',
        'full_name',
        'email',
        'phone',
        'address',
        'image',
        'status',
        'customer_type',
        'wholesale_status',
        'preferred_branch_id',
        'email_verified',
        'email_verified_at',
        'wholesale_requested_at',
        'wholesale_decided_at',
        'wholesale_rejection_reason',
        'archived_at',
        'created_at',
      ].sort(),
    );
  });

  it('never leaks the credential columns', () => {
    const wire = toWireCustomer(row) as unknown as Record<string, unknown>;
    expect(wire).not.toHaveProperty('password_hash');
    // Who decided is an employee id — internal, and not the customer's to see.
    expect(wire).not.toHaveProperty('wholesale_decided_by_user_id');
  });

  it('email_verified follows the timestamp, in both directions', () => {
    expect(toWireCustomer(row).email_verified).toBe(false);
    const proven = toWireCustomer({ ...row, email_verified_at: new Date() });
    expect(proven.email_verified).toBe(true);
    expect(proven.email_verified_at).not.toBeNull();
  });
});

/**
 * Contact policy. Failing here is invisible: a masking that does nothing looks
 * exactly like the data being visible to everyone, and one that masks for
 * everyone looks like a broken list. So both directions, and the masked row
 * must still be the same row (recognisable, not corrupted).
 */
import { applyContactPolicy, maskEmail, maskPhone } from '../dtos/customers.dto.js';

describe('contact policy', () => {
  const wire = toWireCustomer({ ...row, email: 'laila@qirtas.test', phone: '0933111222' });

  it('masks the address but keeps its shape, and never leaks the local part', () => {
    expect(maskEmail('laila@qirtas.test')).toBe('l***@qirtas.test');
    expect(maskEmail('laila@qirtas.test')).not.toContain('aila');
  });

  it('masks the phone but keeps the tail that tells two callers apart', () => {
    expect(maskPhone('0933111222')).toBe('*******222');
    expect(maskPhone(null)).toBeNull();
  });

  it('a malformed address masks to nothing useful instead of throwing', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('@x')).toBe('***');
  });

  it('holders of customers.contact see the real values', () => {
    const seen = applyContactPolicy(wire, true);
    expect(seen.email).toBe('laila@qirtas.test');
    expect(seen.phone).toBe('0933111222');
  });

  it('everyone else sees masked values and keeps every other field', () => {
    const seen = applyContactPolicy(wire, false);
    expect(seen.email).toBe('l***@qirtas.test');
    expect(seen.phone).toBe('*******222');
    expect(seen.full_name).toBe(wire.full_name);
    expect(seen.status).toBe(wire.status);
    expect(seen.id).toBe(wire.id);
  });
});
