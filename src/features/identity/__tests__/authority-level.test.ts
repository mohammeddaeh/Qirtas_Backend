import { describe, it, expect } from 'vitest';
import { canGrantRoleLevel } from '../authority-level.js';

/**
 * A wrong answer here looks like success: the grant returns 200 and someone
 * now holds a role above the person who gave it. So each case sits beside its
 * opposite — a rule that refuses everything passes the refusals alone and
 * leaves nobody able to staff a branch.
 */
describe('canGrantRoleLevel', () => {
  it('grants only roles strictly below the actor (lower number = more authority)', () => {
    expect(canGrantRoleLevel(10, 20)).toBe(true);
    expect(canGrantRoleLevel(10, 10)).toBe(false);
    expect(canGrantRoleLevel(10, 0)).toBe(false);
  });

  it('an actor with no level grants no leveled role — the super admin role included', () => {
    expect(canGrantRoleLevel(null, 0)).toBe(false);
    expect(canGrantRoleLevel(null, 50)).toBe(false);
  });

  it('a level-less role is grantable by anyone who may assign — with or without a level', () => {
    expect(canGrantRoleLevel(null, null)).toBe(true);
    expect(canGrantRoleLevel(10, null)).toBe(true);
  });
});
