import { describe, expect, it } from 'vitest';
import { SHOPPING_NOTIFICATION, shoppingNotificationText } from '../shopping-events.js';

const LRI = '⁦';
const PDI = '⁩';

describe('shopping notification texts', () => {
  it('every event has a title and a body in each language, and the two differ', () => {
    for (const event of Object.values(SHOPPING_NOTIFICATION)) {
      const params = { number: 'BR1-P-2026-000020', pickupCode: '1007-002', amountSyp: 2000, hoursLeft: 72, branch: 'المالكي', productAr: 'دفتر', productEn: 'Notebook', reason: 'الملف تالف' };
      const ar = shoppingNotificationText(event, 'ar', params);
      const en = shoppingNotificationText(event, 'en', params);
      expect(ar.title.length).toBeGreaterThan(0);
      expect(ar.body.length).toBeGreaterThan(0);
      expect(ar.title).not.toBe(en.title);
    }
  });

  it('the pickup code is isolated left-to-right inside the Arabic sentence, or it reads reversed', () => {
    const t = shoppingNotificationText('print_order_ready', 'ar', { pickupCode: '1007-002', branch: 'المالكي' });
    expect(t.body).toContain(`${LRI}1007-002${PDI}`);
  });

  it('a missing number is left out, not printed as an empty isolate', () => {
    const t = shoppingNotificationText('print_order_rejected', 'ar', { reason: 'الملف تالف' });
    expect(t.body).not.toContain(LRI);
    expect(t.body).toContain('الملف تالف');
  });
});
