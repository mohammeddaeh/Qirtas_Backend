import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestOrigin } from '../../../core/auth/services/auth.service.js';
import * as customersRepository from '../repositories/customers.repository.js';
import * as addressesRepository from '../repositories/customer-addresses.repository.js';
import type { CustomerAddressRow } from '../schemas/customer-addresses.schema.js';
import {
  MAX_CUSTOMER_ADDRESSES,
  toWireAddress,
  type CreateAddressBody,
  type UpdateAddressBody,
  type WireCustomerAddress,
} from '../dtos/customer-addresses.dto.js';

/**
 * A customer's delivery addresses (`/customers/me/addresses`).
 *
 * **Every write returns the whole list, not the one row.** The default flag
 * moves between rows — adding the first address, making another the default,
 * deleting the default — so a single-row answer would leave the client holding
 * a stale `is_default` on a row it did not touch.
 */

const notFound = () => new NotFoundError('Address not found');

function toWire(rows: CustomerAddressRow[]): WireCustomerAddress[] {
  return rows.map(toWireAddress);
}

/** `numeric` columns take strings; null stays null, absence stays absent. */
function coords(body: { latitude?: number | null; longitude?: number | null }) {
  const out: { latitude?: string | null; longitude?: string | null } = {};
  if (body.latitude !== undefined) out.latitude = body.latitude === null ? null : String(body.latitude);
  if (body.longitude !== undefined) {
    out.longitude = body.longitude === null ? null : String(body.longitude);
  }
  return out;
}

async function log(
  customerId: number,
  action: string,
  origin: RequestOrigin | undefined,
  details?: Record<string, unknown>,
): Promise<void> {
  // Ids and field names only — the trail is not a second copy of where someone lives.
  await customersRepository.logActivity({
    customerId,
    action,
    details,
    ipAddress: origin?.ipAddress ?? null,
    deviceInfo: origin?.deviceInfo ?? null,
  });
}

export async function list(customerId: number): Promise<WireCustomerAddress[]> {
  return toWire(await addressesRepository.listFor(customerId));
}

export async function create(
  customerId: number,
  body: CreateAddressBody,
  origin?: RequestOrigin,
): Promise<WireCustomerAddress[]> {
  const { make_default, latitude, longitude, ...fields } = body;
  const outcome = await addressesRepository.create(
    customerId,
    { ...fields, ...coords({ latitude, longitude }) },
    make_default ?? false,
    MAX_CUSTOMER_ADDRESSES,
  );
  if (outcome.kind === 'limit') {
    throw new BusinessError(
      409,
      `An account can keep at most ${MAX_CUSTOMER_ADDRESSES} addresses`,
      'address_limit_reached',
      { limit: MAX_CUSTOMER_ADDRESSES },
    );
  }
  await log(customerId, 'customer.address_added', origin);
  return toWire(outcome.rows);
}

export async function update(
  customerId: number,
  addressId: number,
  body: UpdateAddressBody,
  origin?: RequestOrigin,
): Promise<WireCustomerAddress[]> {
  const { latitude, longitude, ...fields } = body;
  const rows = await addressesRepository.update(customerId, addressId, {
    ...fields,
    ...coords({ latitude, longitude }),
  });
  if (!rows) throw notFound();
  await log(customerId, 'customer.address_updated', origin, {
    address_id: addressId,
    fields: Object.keys(body),
  });
  return toWire(rows);
}

export async function makeDefault(
  customerId: number,
  addressId: number,
  origin?: RequestOrigin,
): Promise<WireCustomerAddress[]> {
  const rows = await addressesRepository.makeDefault(customerId, addressId);
  if (!rows) throw notFound();
  await log(customerId, 'customer.address_default_changed', origin, { address_id: addressId });
  return toWire(rows);
}

export async function remove(
  customerId: number,
  addressId: number,
  origin?: RequestOrigin,
): Promise<WireCustomerAddress[]> {
  const rows = await addressesRepository.remove(customerId, addressId);
  if (!rows) throw notFound();
  await log(customerId, 'customer.address_removed', origin, { address_id: addressId });
  return toWire(rows);
}
