import { describe, expect, it, vi } from 'vitest';

import {
  PRINT_JOB_EVENTS,
  emitPrintJobEvent,
  eventForStage,
  onPrintJobEvent,
  type PrintJobEventPayload,
} from '../services/print-job-events.js';

vi.mock('../../../core/logger/logger.js', () => ({ logger: { error: vi.fn() } }));

const job = { id: 7, branch_id: 1, customer_id: null, source: 'counter' as const, number: 'BR1-P-2026-000007' };
const tick = () => new Promise((r) => setImmediate(r));

describe('print job events (9-ح-2)', () => {
  it('a listener hears the move by name — and the caller is not waited on', async () => {
    const heard: PrintJobEventPayload[] = [];
    const off = onPrintJobEvent((p) => {
      heard.push(p);
    });
    emitPrintJobEvent('ready', job);
    // Next tick, never inline: an order printed is printed before anyone hears it.
    expect(heard).toHaveLength(0);
    await tick();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ event: 'ready', jobId: 7, branchId: 1, customerId: null, source: 'counter' });
    off();
  });

  it('a listener that throws is skipped — the next one still hears it', async () => {
    const heard: string[] = [];
    const offA = onPrintJobEvent(() => {
      throw new Error('sms gateway down');
    });
    const offB = onPrintJobEvent((p) => {
      heard.push(p.event);
    });
    expect(() => emitPrintJobEvent('paid', job)).not.toThrow();
    await tick();
    await tick();
    expect(heard).toEqual(['paid']);
    offA();
    offB();
  });

  it('unsubscribed hears nothing', async () => {
    const heard: string[] = [];
    const off = onPrintJobEvent((p) => {
      heard.push(p.event);
    });
    off();
    emitPrintJobEvent('cancelled', job);
    await tick();
    expect(heard).toEqual([]);
  });

  it('staff stages map to their events; every event name is distinct', () => {
    expect(eventForStage('in_production')).toBe('started');
    expect(eventForStage('ready')).toBe('ready');
    expect(eventForStage('picked_up')).toBe('picked_up');
    expect(new Set(PRINT_JOB_EVENTS).size).toBe(PRINT_JOB_EVENTS.length);
  });
});
