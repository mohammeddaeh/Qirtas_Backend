/**
 * Which code a label prints — pure, so each case is tested beside its opposite.
 *
 * **The manufacturer's code first**: it is already printed on the goods, so a
 * shelf label carrying the same one scans the same at the till whichever the
 * cashier reaches for. An internal code is ours alone and wins only when the
 * unit has no other. Among equals the oldest wins — a code added last week
 * does not silently replace the one already on every shelf.
 *
 * `null` when the unit has none: the label prints without a barcode rather
 * than one we made up here, which would scan as nothing at the till.
 */
export function pickLabelBarcode(
  codes: readonly { code: string; source: 'manufacturer' | 'internal' }[],
): string | null {
  return (
    codes.find((c) => c.source === 'manufacturer')?.code ??
    codes.find((c) => c.source === 'internal')?.code ??
    null
  );
}

/**
 * The unit a label is for: the one asked for, else the variant's base unit.
 * A unit that is not the variant's own is `undefined` — the caller refuses it
 * rather than printing a carton price on a piece.
 */
export function pickLabelUnit<U extends { unit_id: number; is_base: boolean }>(
  units: readonly U[],
  requestedUnitId: number | undefined,
): U | undefined {
  return requestedUnitId === undefined
    ? units.find((u) => u.is_base)
    : units.find((u) => u.unit_id === requestedUnitId);
}
