import { describe, expect, it } from 'vitest';
import { PRINT_JOB_STATUSES } from '../schemas/print-jobs.schema.js';
import {
  canMove,
  customerCanCancel,
  fileExpiryFor,
  formatJobNumber,
  hoursLeft,
  isEditable,
  isOverdue,
  isPayable,
  isPrintableLink,
  nextStates,
  paymentDeadline,
  paymentSettled,
  canHandOver,
  statusAfterPayment,
  submitProblem,
} from '../services/job-rules.js';

/**
 * كل خطأ هنا صامت: طابعةٌ تطبع طلباً لم يُدفع، أو طلبٌ يسقط لحظة تسعيره، أو
 * زبونٌ يلغي بعد أن دفع فيختلف الدرج عن الطلبات — والشاشة تعرض حالةً معقولة.
 * لذلك **كل قاعدة مع نقيضها**: «يُسمح بـX» لا تُثبت شيئاً وحدها (دالةٌ تسمح
 * بكل شيء تنجح فيها).
 */

const day = 24 * 60 * 60 * 1000;
const t0 = new Date('2026-09-28T10:00:00Z');

describe('the state machine', () => {
  it('production waits for payment: awaiting_payment cannot jump to in_production', () => {
    expect(canMove('awaiting_payment', 'queued')).toBe(true);
    expect(canMove('awaiting_payment', 'in_production')).toBe(false);
    expect(canMove('awaiting_quote', 'in_production')).toBe(false);
  });

  it('runs queued → in_production → ready → picked_up, one step at a time', () => {
    expect(canMove('queued', 'in_production')).toBe(true);
    expect(canMove('in_production', 'ready')).toBe(true);
    expect(canMove('ready', 'picked_up')).toBe(true);
    expect(canMove('queued', 'ready')).toBe(false);
    expect(canMove('in_production', 'picked_up')).toBe(false);
  });

  it('cancels before payment, never after', () => {
    for (const s of ['draft', 'awaiting_quote', 'awaiting_payment'] as const)
      expect(canMove(s, 'cancelled')).toBe(true);
    for (const s of ['queued', 'in_production', 'ready'] as const)
      expect(canMove(s, 'cancelled')).toBe(false);
  });

  it('expires only while waiting for payment', () => {
    expect(canMove('awaiting_payment', 'expired')).toBe(true);
    expect(canMove('awaiting_quote', 'expired')).toBe(false);
    expect(canMove('draft', 'expired')).toBe(false);
  });

  it('closed states are final', () => {
    for (const s of ['picked_up', 'cancelled', 'expired'] as const)
      expect(nextStates(s)).toEqual([]);
  });

  it('answers every status (a new one breaks the build here, not silently)', () => {
    for (const s of PRINT_JOB_STATUSES) expect(Array.isArray(nextStates(s))).toBe(true);
  });
});

describe('the payment gate', () => {
  it('opens for paid and deferred-by-approval', () => {
    expect(paymentSettled('paid')).toBe(true);
    expect(paymentSettled('deferred')).toBe(true);
  });
  it('stays shut for unpaid', () => {
    expect(paymentSettled('unpaid')).toBe(false);
  });
});

describe('what the till may collect', () => {
  it('a priced, unpaid order', () => {
    expect(isPayable('awaiting_payment', 'unpaid')).toBe(true);
  });

  it('a deferred order at any stage before closing — the debt is still open', () => {
    for (const s of ['queued', 'in_production', 'ready', 'picked_up'] as const) {
      expect(isPayable(s, 'deferred')).toBe(true);
    }
  });

  it('never twice, never before pricing, never a cancelled or expired one', () => {
    expect(isPayable('queued', 'paid')).toBe(false);
    expect(isPayable('picked_up', 'paid')).toBe(false);
    expect(isPayable('awaiting_quote', 'unpaid')).toBe(false);
    expect(isPayable('draft', 'unpaid')).toBe(false);
    expect(isPayable('cancelled', 'deferred')).toBe(false);
    expect(isPayable('expired', 'unpaid')).toBe(false);
  });

  it('an unpaid order in production is not collectable (it cannot exist — the gate stops it)', () => {
    expect(isPayable('in_production', 'unpaid')).toBe(false);
  });

  it('payment moves a waiting order into the queue — and a ready one out of the door', () => {
    expect(statusAfterPayment('awaiting_payment')).toBe('queued');
    // Printed before payment, paid at the till with the copies in hand (9-ز-4).
    expect(statusAfterPayment('ready')).toBe('picked_up');
    // Deferred mid-production stays where it is — nothing is in the customer's hand yet.
    expect(statusAfterPayment('in_production')).toBe('in_production');
    expect(statusAfterPayment('picked_up')).toBe('picked_up');
  });

  it('copies leave the counter paid — deferred still owes', () => {
    expect(canHandOver('ready', 'paid')).toBe(true);
    expect(canHandOver('ready', 'deferred')).toBe(false);
    expect(canHandOver('ready', 'unpaid')).toBe(false);
    expect(canHandOver('in_production', 'paid')).toBe(false);
  });
});

describe('who may change and cancel', () => {
  it('only the draft is editable', () => {
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('awaiting_quote')).toBe(false);
    expect(isEditable('awaiting_payment')).toBe(false);
  });

  it('the customer cancels what is not paid, and nothing after', () => {
    expect(customerCanCancel('awaiting_payment')).toBe(true);
    expect(customerCanCancel('queued')).toBe(false);
    expect(customerCanCancel('picked_up')).toBe(false);
  });
});

describe('submitProblem', () => {
  const base = { readyFiles: 0, pendingFiles: 0, unusableFiles: 0, links: 0 };

  it('accepts a ready file, or a link alone', () => {
    expect(submitProblem({ ...base, readyFiles: 1 })).toBeNull();
    expect(submitProblem({ ...base, links: 1 })).toBeNull();
  });

  it('refuses an empty draft', () => {
    expect(submitProblem(base)).toBe('nothing_to_print');
  });

  it('refuses while a file is still uploading, even with others ready', () => {
    expect(submitProblem({ ...base, readyFiles: 3, pendingFiles: 1 })).toBe('files_uploading');
  });

  it('refuses while a rejected or deleted file is still attached', () => {
    expect(submitProblem({ ...base, readyFiles: 2, unusableFiles: 1 })).toBe('files_unusable');
  });
});

describe('the unpaid deadline', () => {
  it('three days after pricing', () => {
    expect(paymentDeadline(t0, 3)?.getTime()).toBe(t0.getTime() + 3 * day);
  });

  it('zero means no deadline, not "expire at once"', () => {
    expect(paymentDeadline(t0, 0)).toBeNull();
  });

  it('is overdue at the deadline, not a second before', () => {
    const due = new Date(t0.getTime() + day);
    expect(isOverdue('awaiting_payment', due, new Date(due.getTime() - 1000))).toBe(false);
    expect(isOverdue('awaiting_payment', due, due)).toBe(true);
  });

  it('never marks a paid or unpriced job overdue, nor one without a deadline', () => {
    const past = new Date(t0.getTime() - day);
    expect(isOverdue('queued', past, t0)).toBe(false);
    expect(isOverdue('awaiting_quote', past, t0)).toBe(false);
    expect(isOverdue('awaiting_payment', null, t0)).toBe(false);
  });

  it('counts hours left rounded up, and never below zero', () => {
    expect(hoursLeft(new Date(t0.getTime() + 90 * 60 * 1000), t0)).toBe(2);
    expect(hoursLeft(new Date(t0.getTime() - 1000), t0)).toBe(0);
    expect(hoursLeft(null, t0)).toBeNull();
  });
});

describe('file retention by status', () => {
  it('keeps files while the job is alive', () => {
    for (const s of [
      'awaiting_quote',
      'awaiting_payment',
      'queued',
      'in_production',
      'ready',
    ] as const) {
      expect(fileExpiryFor(s, t0, 30)).toBeNull();
    }
  });

  it('counts the retention from pickup', () => {
    expect((fileExpiryFor('picked_up', t0, 30) as Date).getTime()).toBe(t0.getTime() + 30 * day);
  });

  it('gives a closed job a week, whatever the pickup retention', () => {
    expect((fileExpiryFor('cancelled', t0, 30) as Date).getTime()).toBe(t0.getTime() + 7 * day);
    expect((fileExpiryFor('expired', t0, 90) as Date).getTime()).toBe(t0.getTime() + 7 * day);
  });

  it('leaves a draft on the media default', () => {
    expect(fileExpiryFor('draft', t0, 30)).toBe('unchanged');
  });
});

describe('links', () => {
  it.each(['https://drive.google.com/file/d/abc/view', 'https://example.com/a.pdf'])(
    'accepts %s',
    (url) => {
      expect(isPrintableLink(url)).toBe(true);
    },
  );

  it.each([
    'http://example.com/a.pdf',
    'file:///C:/secret.pdf',
    'javascript:alert(1)',
    'https://localhost/a.pdf',
    'https://user:pass@example.com/a.pdf',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isPrintableLink(url)).toBe(false);
  });
});

describe('formatJobNumber', () => {
  it('carries P so print orders never collide with sales or orders', () => {
    expect(formatJobNumber('mz', 2026, 7)).toBe('MZ-P-2026-000007');
  });
});
