/**
 * What makes a set of variants coherent — store_system.md §٩.
 *
 * Pure functions: the service loads the attribute values and the category's
 * allowed types, then asks these. Every rule here is one whose violation saves
 * happily and breaks later — a variant with two colours, a product whose
 * variants disagree on what distinguishes them (one by colour, one by size),
 * two variants that are secretly the same one.
 */

export const MAX_PRODUCT_AXES = 3;

export interface ValueRef {
  id: number;
  typeId: number;
}

export type VariantProblem =
  | { kind: 'unknown_value'; valueId: number }
  | { kind: 'type_not_allowed'; typeId: number }
  | { kind: 'type_repeated'; typeId: number }
  | { kind: 'too_many_axes' }
  | { kind: 'axes_mismatch' }
  | { kind: 'duplicate_combination' };

/** Stable key for a combination: sorted value ids. The empty combination (a simple product) is `''`. */
export function combinationKey(valueIds: readonly number[]): string {
  return [...valueIds].sort((a, b) => a - b).join('-');
}

/** The attribute types a variant uses, sorted — its "axes". */
export function axesOf(values: readonly ValueRef[]): number[] {
  return [...new Set(values.map((v) => v.typeId))].sort((a, b) => a - b);
}

/**
 * Checks every variant of a product together.
 *
 * [variants] are the value-id lists of ALL variants the product will have
 * after the change (existing + new), so a new variant is judged against the
 * ones already saved.
 */
export function variantSetProblem(
  variants: readonly (readonly number[])[],
  valueById: ReadonlyMap<number, ValueRef>,
  allowedTypeIds: ReadonlySet<number>,
): VariantProblem | null {
  let productAxes: string | null = null;
  const seen = new Set<string>();

  for (const valueIds of variants) {
    const values: ValueRef[] = [];
    for (const id of valueIds) {
      const value = valueById.get(id);
      if (!value) return { kind: 'unknown_value', valueId: id };
      values.push(value);
    }

    const typeCounts = new Map<number, number>();
    for (const value of values) {
      if (!allowedTypeIds.has(value.typeId))
        return { kind: 'type_not_allowed', typeId: value.typeId };
      typeCounts.set(value.typeId, (typeCounts.get(value.typeId) ?? 0) + 1);
    }
    for (const [typeId, n] of typeCounts) if (n > 1) return { kind: 'type_repeated', typeId };

    const axes = axesOf(values);
    if (axes.length > MAX_PRODUCT_AXES) return { kind: 'too_many_axes' };
    const axesKey = axes.join(',');
    if (productAxes === null) productAxes = axesKey;
    else if (productAxes !== axesKey) return { kind: 'axes_mismatch' };

    const key = combinationKey(valueIds);
    if (seen.has(key)) return { kind: 'duplicate_combination' };
    seen.add(key);
  }
  return null;
}
