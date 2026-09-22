import { z } from 'zod';
import { phoneSchema } from './customers.dto.js';
import type { CustomerAddressRow } from '../schemas/customer-addresses.schema.js';

/**
 * How many places one customer keeps. A cap, not a limit anyone is expected to
 * reach — without it the checkout picker has no bound.
 */
export const MAX_CUSTOMER_ADDRESSES = 10;

const coordinate = (limit: number) => z.coerce.number().min(-limit).max(limit);

const addressFields = {
  kind: z.enum(['home', 'work', 'other']),
  label: z.string().trim().min(1).max(50).nullable(),
  recipient_name: z.string().trim().min(1).max(200).nullable(),
  recipient_phone: phoneSchema.nullable(),
  area: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(1000),
  landmark: z.string().trim().min(1).max(255).nullable(),
  latitude: coordinate(90).nullable(),
  longitude: coordinate(180).nullable(),
};

/** Both halves of a pin or neither — the same rule the table's CHECK holds. */
function pinIsWhole(v: { latitude?: number | null; longitude?: number | null }): boolean {
  const lat = v.latitude ?? null;
  const lng = v.longitude ?? null;
  return (lat === null) === (lng === null);
}

const pinMessage = { message: 'latitude and longitude go together', path: ['latitude'] };

/**
 * `POST /customers/me/addresses`.
 *
 * `make_default` is optional because the first address becomes the default
 * whatever it says — a customer with addresses but no default would reach
 * checkout with nothing preselected.
 */
export const createAddressBodySchema = z
  .object({
    ...addressFields,
    kind: addressFields.kind.default('home'),
    label: addressFields.label.optional(),
    recipient_name: addressFields.recipient_name.optional(),
    recipient_phone: addressFields.recipient_phone.optional(),
    landmark: addressFields.landmark.optional(),
    latitude: addressFields.latitude.optional(),
    longitude: addressFields.longitude.optional(),
    make_default: z.boolean().optional(),
  })
  .refine(pinIsWhole, pinMessage);
export type CreateAddressBody = z.infer<typeof createAddressBodySchema>;

/**
 * `PATCH /customers/me/addresses/:addressId`. No `is_default` here: the default
 * moves through `make-default` only, so one endpoint owns the rule that exactly
 * one row holds it.
 */
export const updateAddressBodySchema = z
  .object(addressFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' })
  // A pin is replaced whole; half of one would pass the field checks and fail the CHECK.
  .refine((v) => ('latitude' in v) === ('longitude' in v) && pinIsWhole(v), pinMessage);
export type UpdateAddressBody = z.infer<typeof updateAddressBodySchema>;

export const addressIdParamsSchema = z.object({
  addressId: z.coerce.number().int().positive(),
});

export interface WireCustomerAddress {
  id: number;
  kind: CustomerAddressRow['kind'];
  label: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  /** Empty only on a row carried over from the old single text column. */
  area: string;
  details: string;
  landmark: string | null;
  latitude: number | null;
  longitude: number | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export function toWireAddress(row: CustomerAddressRow): WireCustomerAddress {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    recipient_name: row.recipient_name,
    recipient_phone: row.recipient_phone,
    area: row.area,
    details: row.details,
    landmark: row.landmark,
    // `numeric` arrives as a string from the driver.
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    is_default: row.is_default,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
