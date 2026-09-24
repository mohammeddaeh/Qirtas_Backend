/**
 * Barcode rules — docs/reference/store_system.md §٧.
 *
 * A code is NOT unique on its own *within one product*. Factories print one
 * code on the piece, the box and the carton, or one code for every colour of a
 * pen; refusing such a code would refuse real stock at the receiving desk.
 * Uniqueness is on (code + variant + unit), and a code matching more than one
 * of those is an *ambiguity* the scanner resolves with one tap and the
 * dashboard flags for a permanent fix (an internal label over the factory
 * code).
 *
 * Across *products* the code is refused (`barcode_on_other_product`, enforced
 * in products.service.ts): the tap that resolves piece-vs-box resolves nothing
 * between two unrelated items — the cashier holds one thing and the screen
 * offers two, with nothing on the shelf to tell them apart.
 */

/** Printable codes this system accepts: 4–32 of digits, capital letters and `-`. */
const CODE_PATTERN = /^[0-9A-Z-]{4,32}$/;

export function normalizeBarcode(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase();
}

export type BarcodeProblem = 'format' | 'checksum';

/**
 * EAN-8, UPC-A (12) and EAN-13 carry a check digit. A code of that exact
 * shape whose check digit is wrong is a typo, and accepting it would create a
 * barcode no scanner will ever produce — the product then "can't be found"
 * forever, with nothing pointing at why.
 */
export function barcodeProblem(code: string): BarcodeProblem | null {
  if (!CODE_PATTERN.test(code)) return 'format';
  if (/^\d+$/.test(code) && [8, 12, 13].includes(code.length)) {
    const body = code.slice(0, -1);
    if (gtinCheckDigit(body) !== Number(code.at(-1))) return 'checksum';
  }
  return null;
}

/** GS1 check digit: weights 3,1,3,1… from the rightmost body digit. */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Internal EAN-13: prefix `20` + a 10-digit running number + check digit.
 *
 * GS1 reserves prefixes 20–29 for in-store use, so an internal code can never
 * collide with a real manufacturer's code — whatever the factory prints.
 */
export const INTERNAL_BARCODE_PREFIX = '20';
const INTERNAL_BODY_DIGITS = 10;

export function internalBarcode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= 10 ** INTERNAL_BODY_DIGITS) {
    throw new Error(`Internal barcode sequence out of range: ${sequence}`);
  }
  const body = INTERNAL_BARCODE_PREFIX + String(sequence).padStart(INTERNAL_BODY_DIGITS, '0');
  return body + String(gtinCheckDigit(body));
}

export function isInternalBarcode(code: string): boolean {
  return /^2\d{12}$/.test(code);
}

export interface BarcodeMatch {
  variantId: number;
  unitId: number;
}

/**
 * What a scan of one code resolves to.
 *
 * - `none` — one match, add it.
 * - `unit` — one variant in several units (piece/box/carton): offer the units.
 * - `item` — several variants (every colour under one code): offer the variants.
 */
export type BarcodeAmbiguity = 'none' | 'unit' | 'item';

/**
 * How bad a shared code is.
 *
 * - `in_product` — one product wearing its code on several units or colours.
 *   The scanner asks which, the cashier taps once, and the answer is always
 *   the thing in their hand.
 * - `cross_product` — two unrelated products under one code. No tap resolves
 *   that, so it needs a person: an internal label on one of them. New ones are
 *   refused (`barcode_on_other_product`); the ones in the list were written
 *   before that rule.
 */
export type SharedCodeScope = 'in_product' | 'cross_product';

export function sharedScopeOf(productIds: readonly number[]): SharedCodeScope {
  return new Set(productIds).size > 1 ? 'cross_product' : 'in_product';
}

export function ambiguityOf(matches: readonly BarcodeMatch[]): BarcodeAmbiguity {
  if (matches.length <= 1) return 'none';
  const variants = new Set(matches.map((m) => m.variantId));
  return variants.size > 1 ? 'item' : 'unit';
}
