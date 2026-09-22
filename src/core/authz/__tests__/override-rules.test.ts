import { describe, it, expect } from 'vitest';
import { overrideRefusal } from '../override-rules.js';

/**
 * A missing rule here looks like success: the write returns 200 and the account
 * simply holds more than anyone decided it should. So every refusal is paired
 * with the case that must still pass — a rule that refuses everything would
 * satisfy the refusals alone and make the screen unusable.
 */

type Input = Parameters<typeof overrideRefusal>[0];

const ACTOR = 1;
const TARGET = 2;

function input(over: Partial<Input> = {}): Input {
  return {
    actorUserId: ACTOR,
    target: { id: TARGET, status: 'active', isRootProtected: false },
    actorKeys: ['users.access', 'branches.manage'],
    actorLevel: 5,
    targetLevel: null,
    existing: [],
    requested: [],
    ...over,
  };
}

describe('overrideRefusal — escalation', () => {
  it('refuses granting a key the actor does not hold — including to themselves', () => {
    const toOther = overrideRefusal(input({ requested: [{ key: 'permissions.manage', effect: 'allow' }] }));
    expect(toOther?.key).toBe('override_key_not_held');

    const toSelf = overrideRefusal(
      input({
        target: { id: ACTOR, status: 'active', isRootProtected: false },
        requested: [{ key: 'users.delete', effect: 'allow' }],
      }),
    );
    expect(toSelf?.key).toBe('override_key_not_held');
  });

  it('allows granting a key the actor holds', () => {
    expect(overrideRefusal(input({ requested: [{ key: 'branches.manage', effect: 'allow' }] }))).toBeNull();
  });

  it('keeps an allow granted earlier by someone else — only additions are judged', () => {
    const resubmitted = input({
      existing: [{ permission_key: 'audit_log.view', effect: 'allow' }],
      requested: [{ key: 'audit_log.view', effect: 'allow' }],
    });
    expect(overrideRefusal(resubmitted)).toBeNull();
  });

  it('a deny is never an escalation — even of a key the actor lacks', () => {
    expect(overrideRefusal(input({ requested: [{ key: 'permissions.manage', effect: 'deny' }] }))).toBeNull();
  });
});

describe('overrideRefusal — root protection', () => {
  it('refuses any change to a root-protected account by someone else, deny included', () => {
    const r = overrideRefusal(
      input({
        target: { id: TARGET, status: 'active', isRootProtected: true },
        requested: [{ key: 'users.access', effect: 'deny' }],
      }),
    );
    expect(r?.key).toBe('user_root_protected');
  });

  it('the root account may still manage its own exceptions', () => {
    const r = overrideRefusal(
      input({
        target: { id: ACTOR, status: 'active', isRootProtected: true },
        requested: [{ key: 'branches.manage', effect: 'deny' }],
      }),
    );
    expect(r).toBeNull();
  });
});

describe('overrideRefusal — authority level', () => {
  it('refuses acting on an account of equal or higher authority', () => {
    expect(overrideRefusal(input({ actorLevel: 5, targetLevel: 5 }))?.key).toBe('override_target_outranks_actor');
    expect(overrideRefusal(input({ actorLevel: 5, targetLevel: 0 }))?.key).toBe('override_target_outranks_actor');
  });

  it('an actor with no authority does not outrank a target that has some', () => {
    expect(overrideRefusal(input({ actorLevel: null, targetLevel: 9 }))?.key).toBe('override_target_outranks_actor');
  });

  it('allows acting on lower authority, or on a target with none', () => {
    expect(overrideRefusal(input({ actorLevel: 2, targetLevel: 5 }))).toBeNull();
    expect(overrideRefusal(input({ actorLevel: null, targetLevel: null }))).toBeNull();
  });
});

describe('overrideRefusal — account status', () => {
  it('refuses a new allow on an account that is not active — approval is not skippable', () => {
    for (const status of ['pending_verification', 'pending_approval', 'rejected', 'suspended']) {
      const r = overrideRefusal(
        input({
          target: { id: TARGET, status, isRootProtected: false },
          requested: [{ key: 'branches.manage', effect: 'allow' }],
        }),
      );
      expect(r?.key, status).toBe('override_target_not_active');
    }
  });

  it('still allows narrowing a non-active account', () => {
    const r = overrideRefusal(
      input({
        target: { id: TARGET, status: 'pending_approval', isRootProtected: false },
        requested: [{ key: 'branches.manage', effect: 'deny' }],
      }),
    );
    expect(r).toBeNull();
  });
});

describe('assertOverrideAllowed', () => {
  it('throws the refusal with its message key — and does not throw when allowed', async () => {
    const { assertOverrideAllowed } = await import('../override-rules.js');
    expect(() =>
      assertOverrideAllowed(input({ requested: [{ key: 'permissions.manage', effect: 'allow' }] })),
    ).toThrow(expect.objectContaining({ httpStatus: 403, messageKey: 'override_key_not_held' }));
    expect(() => assertOverrideAllowed(input())).not.toThrow();
  });
});
