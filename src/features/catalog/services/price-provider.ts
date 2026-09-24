import { registerPriceResolver } from '../../../core/pricing/price-port.js';
import { resolveAt } from './pricing.service.js';

/**
 * The catalog's answer to "what does this cost here", handed to the port.
 *
 * Registered by the composition root rather than imported by its callers, so a
 * server that ships without the catalog has **no** price resolver — and every
 * storefront row reads as unpriced instead of showing goods at a number
 * nobody set.
 */
export function installCatalogPriceResolver(): void {
  registerPriceResolver((branchId, variantIds, ctx) => resolveAt(branchId, variantIds, ctx));
}
