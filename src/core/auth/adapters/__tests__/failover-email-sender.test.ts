import { describe, expect, it } from 'vitest';
import { FailoverEmailSender } from '../failover-email-sender.js';
import type { EmailDeliveryResult, EmailMessage, EmailSender } from '../../ports/email-sender.js';

const message: EmailMessage = { to: 'a@b.com', kind: 'email_verification', subject: 's', text: 't' };

function fake(result: EmailDeliveryResult): EmailSender & { calls: number } {
  const s = {
    calls: 0,
    async send() {
      s.calls++;
      return result;
    },
  };
  return s;
}

describe('FailoverEmailSender', () => {
  it('uses the primary and never touches the fallback when the primary works', async () => {
    const primary = fake({ ok: true, messageId: 'p' });
    const backup = fake({ ok: true, messageId: 'b' });
    const result = await new FailoverEmailSender([
      { name: 'primary', sender: primary },
      { name: 'fallback', sender: backup },
    ]).send(message);
    expect(result).toEqual({ ok: true, messageId: 'p' });
    expect(backup.calls).toBe(0);
  });

  it('falls back on ANY primary failure — including "rejected", which is often one server\'s policy', async () => {
    for (const errorCode of ['connection', 'auth', 'rejected', 'unknown', 'no_transport'] as const) {
      const primary = fake({ ok: false, errorCode });
      const backup = fake({ ok: true, messageId: 'b' });
      const result = await new FailoverEmailSender([
        { name: 'primary', sender: primary },
        { name: 'fallback', sender: backup },
      ]).send(message);
      expect(result.ok, errorCode).toBe(true);
      expect(backup.calls, errorCode).toBe(1);
    }
  });

  it('when every account fails it reports the LAST failure, and tried each exactly once', async () => {
    const first = fake({ ok: false, errorCode: 'connection' });
    const second = fake({ ok: false, errorCode: 'auth' });
    const result = await new FailoverEmailSender([
      { name: 'primary', sender: first },
      { name: 'fallback', sender: second },
    ]).send(message);
    expect(result).toEqual({ ok: false, errorCode: 'auth' });
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it('refuses an empty chain rather than silently sending nothing', () => {
    expect(() => new FailoverEmailSender([])).toThrow();
  });
});
