/**
 * **Rarely-changing reads, remembered for a few seconds** (2026-10-14).
 *
 * The category tree, the rounding bands and the exchange rate were read again
 * for every price resolved — every line added at the till, every storefront
 * page, every cart. They change a few times a month.
 *
 * - The **promise** is kept, so a burst of requests shares one load.
 * - A write clears it by name ([clearCache]) — the writer's process answers
 *   from the database on its next read; another process within [ttlMs].
 * - A failed load is not remembered.
 */
/** Category id → its ancestor path (promotions). Cleared with the category tree. */
export const CATEGORY_PATHS_CACHE = 'category-paths';
/** Live promotions the price path reads. Cleared by every promotion write. */
export const PROMOTION_CANDIDATES_CACHE = 'promotion-candidates';

const registry = new Map<string, () => void>();

export interface TtlCache<T> {
  get(): Promise<T>;
  clear(): void;
}

export function ttlCache<T>(name: string, ttlMs: number, load: () => Promise<T>): TtlCache<T> {
  let entry: { at: number; value: Promise<T> } | null = null;
  const clear = (): void => {
    entry = null;
  };
  registry.set(name, clear);
  return {
    get() {
      const now = Date.now();
      if (entry && now - entry.at < ttlMs) return entry.value;
      const value = load();
      const mine = { at: now, value };
      entry = mine;
      value.catch(() => {
        if (entry === mine) entry = null;
      });
      return value;
    },
    clear,
  };
}

/** A write changed what the named cache holds. Unknown names are ignored. */
export function clearCache(name: string): void {
  registry.get(name)?.();
}
