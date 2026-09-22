import { describe, expect, it } from 'vitest';
import {
  createAddressBodySchema,
  toWireAddress,
  updateAddressBodySchema,
} from '../dtos/customer-addresses.dto.js';

/**
 * A half pin passes every field check and then fails the table's CHECK as a
 * 500 — or, worse, a client that rounds it off stores a point in the sea. Each
 * case is proven alongside its opposite: accepting a whole pin proves nothing on
 * its own (a schema with no pin rule accepts it too).
 */
describe('address pin', () => {
  const base = { area: 'المزة', details: 'بناء ٣، طابق ٢' };

  it('accepts no pin, and a whole pin', () => {
    expect(createAddressBodySchema.safeParse(base).success).toBe(true);
    expect(
      createAddressBodySchema.safeParse({ ...base, latitude: 33.5, longitude: 36.27 }).success,
    ).toBe(true);
  });

  it('rejects half a pin, either half', () => {
    expect(createAddressBodySchema.safeParse({ ...base, latitude: 33.5 }).success).toBe(false);
    expect(createAddressBodySchema.safeParse({ ...base, longitude: 36.27 }).success).toBe(false);
  });

  it('PATCH replaces a pin whole or clears it whole', () => {
    expect(updateAddressBodySchema.safeParse({ latitude: 1, longitude: 2 }).success).toBe(true);
    expect(updateAddressBodySchema.safeParse({ latitude: null, longitude: null }).success).toBe(
      true,
    );
    expect(updateAddressBodySchema.safeParse({ latitude: 1 }).success).toBe(false);
    expect(updateAddressBodySchema.safeParse({ latitude: null }).success).toBe(false);
  });

  it('requires area and details on create — the text a courier follows', () => {
    expect(createAddressBodySchema.safeParse({ details: 'x' }).success).toBe(false);
    expect(createAddressBodySchema.safeParse({ area: 'x' }).success).toBe(false);
  });

  it('PATCH cannot move the default — make-default owns that rule', () => {
    const parsed = updateAddressBodySchema.safeParse({ area: 'x', is_default: true });
    expect(parsed.success && 'is_default' in parsed.data).toBe(false);
  });
});

describe('WireCustomerAddress', () => {
  it('turns numeric strings into numbers, and keeps null as null (not 0)', () => {
    const now = new Date('2026-09-21T10:00:00.000Z');
    const row = {
      id: 1,
      customer_id: 9,
      kind: 'home' as const,
      label: null,
      recipient_name: null,
      recipient_phone: null,
      area: '',
      details: 'x',
      landmark: null,
      latitude: '33.513800',
      longitude: '36.276500',
      is_default: true,
      created_at: now,
      updated_at: now,
    };
    const wire = toWireAddress(row);
    expect(wire.latitude).toBe(33.5138);
    expect(wire.longitude).toBe(36.2765);
    expect('customer_id' in wire).toBe(false);

    const unpinned = toWireAddress({ ...row, latitude: null, longitude: null });
    expect(unpinned.latitude).toBeNull();
    expect(unpinned.longitude).toBeNull();
  });
});
