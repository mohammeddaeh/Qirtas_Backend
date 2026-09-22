import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from '../../i18n/messages.js';
import { NOTIFICATION, notificationText } from '../events.js';

describe('notification texts', () => {
  it('every event has a non-empty title and body in every supported language', () => {
    for (const event of Object.values(NOTIFICATION)) {
      for (const lang of SUPPORTED_LANGUAGES) {
        const t = notificationText(event, lang, { reason: 'x' });
        expect(t.title.length, `${event}/${lang} title`).toBeGreaterThan(0);
        expect(t.body.length, `${event}/${lang} body`).toBeGreaterThan(0);
      }
    }
  });

  it('a stated reason is shown to the person in the events that carry one — and only then', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const withReason = notificationText(NOTIFICATION.wholesaleRejected, lang, { reason: 'ملف ناقص' });
      const without = notificationText(NOTIFICATION.wholesaleRejected, lang, {});
      expect(withReason.body).toContain('ملف ناقص');
      expect(without.body).not.toContain('ملف ناقص');
      expect(without.body.split('\n')).toHaveLength(1);
    }
    // An event with no reason slot ignores one instead of printing it.
    const approved = notificationText(NOTIFICATION.wholesaleApproved, 'en', { reason: 'leak' });
    expect(approved.body).not.toContain('leak');
  });

  it('the two languages actually differ (a copy-pasted string would pass the first test)', () => {
    for (const event of Object.values(NOTIFICATION)) {
      expect(notificationText(event, 'ar').title).not.toBe(notificationText(event, 'en').title);
    }
  });
});
