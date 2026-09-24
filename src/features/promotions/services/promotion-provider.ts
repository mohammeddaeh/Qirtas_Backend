import { registerPromotionResolver } from '../../../core/promotions/promotion-port.js';
import { resolveOn } from './promotions.service.js';

/**
 * The promotions module's answer to "what comes off this price", handed to the
 * port.
 *
 * Registered by the composition root rather than imported by the catalogue, so
 * a server shipped without this module has **no** promotion resolver and every
 * shelf shows the listed price — rather than a discount computed by a rule
 * that is not installed.
 */
export function installPromotionResolver(): void {
  registerPromotionResolver((ctx, items) => resolveOn(ctx, items));
}
