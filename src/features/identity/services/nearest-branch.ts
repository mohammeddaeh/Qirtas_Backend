/**
 * Which branch is closest to a point — the rule behind "the app opens on the
 * branch nearest you".
 *
 * Pure on purpose: the failure of this rule looks like nothing. A wrong pick
 * still returns a real branch with real prices, so a swapped latitude/longitude
 * or a missing `Math.abs` sends a Damascus shopper to a Latakia catalogue and
 * every screen renders normally. Hence the tests in `__tests__/`.
 */

export interface Located {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres (haversine). */
export function distanceKm(a: Located, b: Located): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The closest of [candidates] to [from], or undefined when none has coordinates.
 * Ties break on the lower id, so the answer is stable rather than depending on
 * the order the database happened to return rows in.
 */
export function pickNearest<T extends { id: number; latitude: number | null; longitude: number | null }>(
  candidates: T[],
  from: Located,
): { branch: T; distanceKm: number } | undefined {
  let best: { branch: T; distanceKm: number } | undefined;

  for (const branch of candidates) {
    if (branch.latitude === null || branch.longitude === null) continue;
    const d = distanceKm(from, { latitude: branch.latitude, longitude: branch.longitude });
    if (!best || d < best.distanceKm || (d === best.distanceKm && branch.id < best.branch.id)) {
      best = { branch, distanceKm: d };
    }
  }
  return best;
}
