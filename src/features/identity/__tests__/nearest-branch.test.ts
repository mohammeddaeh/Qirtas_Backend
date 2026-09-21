import { describe, expect, it } from 'vitest';
import { distanceKm, pickNearest } from '../services/nearest-branch.js';

/**
 * A wrong pick is invisible: it still returns a real branch. So each case is
 * paired with its opposite — picking the nearest proves nothing on its own
 * (a function returning the first row passes it), so the far branch is listed
 * first and the near one last.
 */
const damascus = { id: 1, latitude: 33.5138, longitude: 36.2765 };
const aleppo = { id: 2, latitude: 36.2021, longitude: 37.1343 };
const latakia = { id: 3, latitude: 35.5317, longitude: 35.7915 };

describe('distanceKm', () => {
  it('is ~0 for the same point and symmetric', () => {
    expect(distanceKm(damascus, damascus)).toBeCloseTo(0, 5);
    expect(distanceKm(damascus, aleppo)).toBeCloseTo(distanceKm(aleppo, damascus), 6);
  });

  it('matches the real Damascus–Aleppo distance (~305 km straight line)', () => {
    const d = distanceKm(damascus, aleppo);
    expect(d).toBeGreaterThan(290);
    expect(d).toBeLessThan(320);
  });

  it('does not confuse latitude with longitude', () => {
    const swapped = { latitude: damascus.longitude, longitude: damascus.latitude };
    expect(distanceKm(damascus, swapped)).toBeGreaterThan(100);
  });
});

describe('pickNearest', () => {
  it('picks the nearest even when it is listed last', () => {
    const nearDouma = { latitude: 33.57, longitude: 36.4 };
    const pick = pickNearest([aleppo, latakia, damascus], nearDouma);
    expect(pick?.branch.id).toBe(1);
  });

  it('picks a different branch for a different point (not a constant answer)', () => {
    const nearAleppo = { latitude: 36.2, longitude: 37.15 };
    expect(pickNearest([damascus, aleppo, latakia], nearAleppo)?.branch.id).toBe(2);
  });

  it('skips branches without coordinates instead of treating them as distance 0', () => {
    const unplaced = { id: 9, latitude: null, longitude: null };
    const pick = pickNearest([unplaced, aleppo], damascus);
    expect(pick?.branch.id).toBe(2);
  });

  it('returns undefined when no branch has coordinates', () => {
    expect(pickNearest([{ id: 9, latitude: null, longitude: null }], damascus)).toBeUndefined();
    expect(pickNearest([], damascus)).toBeUndefined();
  });

  it('breaks an exact tie on the lower id, whatever the input order', () => {
    const a = { id: 5, latitude: 34, longitude: 36 };
    const b = { id: 4, latitude: 34, longitude: 36 };
    expect(pickNearest([a, b], damascus)?.branch.id).toBe(4);
    expect(pickNearest([b, a], damascus)?.branch.id).toBe(4);
  });
});
