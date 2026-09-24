/**
 * Drizzle schema barrel.
 * Every feature's `schemas/*.schema.ts` MUST be re-exported here — drizzle-kit
 * only reads this one file to discover tables. See src/core/CLAUDE.md.
 *
 * NOTE: run drizzle-kit via `npm run db:generate`/`db:migrate`/`db:push` (they
 * invoke it through tsx — see package.json), never `npx drizzle-kit` directly.
 * drizzle-kit's own CJS loader cannot resolve `.js`-suffixed relative imports
 * (required everywhere else by NodeNext + tsx at runtime); running it through
 * tsx resolves that mismatch without needing an extension-less exception here.
 */
export * from '../../features/identity/schemas/branches.schema.js';
export * from '../../features/identity/schemas/roles.schema.js';
export * from '../../features/identity/schemas/permissions.schema.js';
export * from '../../features/identity/schemas/role-permissions.schema.js';
export * from '../../features/identity/schemas/users.schema.js';
export * from '../../features/identity/schemas/user-role-assignments.schema.js';
export * from '../../features/identity/schemas/ownerships.schema.js';
export * from '../../features/identity/schemas/audit-log-entries.schema.js';
// Authentication tables — moved out of features/identity 2026-08-11 because
// they belong to the reusable engine, not to Qirtas's user model. See
// core/auth/schemas/sessions.schema.ts for the full reasoning.
export * from '../auth/schemas/sessions.schema.js';
export * from '../auth/schemas/verification-tokens.schema.js';
export * from '../auth/schemas/account-emails.schema.js';
export * from '../auth/schemas/mfa.schema.js';
export * from '../auth/schemas/session-tombstones.schema.js';
export * from '../notifications/schemas/device-push-tokens.schema.js';
export * from '../../features/customers/schemas/customers.schema.js';
export * from '../../features/customers/schemas/customer-addresses.schema.js';

/**
 * Per-account exceptions to what the roles grant. Owned by `core/authz/`
 * because the mechanism is generic — the roles, branches and assignment history
 * that make it *Qirtas's* stay in `features/identity/`.
 */
export * from '../authz/schemas/user-permission-overrides.schema.js';
export * from '../../features/localization/schemas/languages.schema.js';
export * from '../../features/localization/schemas/translation-entries.schema.js';

// Staging for two-phase imports. Owned by core/data-transfer/ and shared by
// every resource — see its own doc for why a table rather than a Map.
export * from '../data-transfer/schemas/import-staging.schema.js';

// Shared rate-limit counters. The table exists in every database regardless of
// `RATE_LIMIT_STORE` — an unused table costs nothing, and a migration that has
// to be applied *before* scaling out is one that gets forgotten in the hour it
// is needed.
export * from '../security/schemas/rate-limits.schema.js';

// Uploaded files and their renditions. Owned by core/media/ because catalog,
// printing and customization all point at it, and a feature may not import
// another feature.
export * from '../media/schemas/media-assets.schema.js';

// The central catalog (features/catalog/) — docs/reference/store_system.md §٩.
export * from '../../features/catalog/schemas/catalog-enums.schema.js';
export * from '../../features/catalog/schemas/units.schema.js';
export * from '../../features/catalog/schemas/attributes.schema.js';
export * from '../../features/catalog/schemas/categories.schema.js';
export * from '../../features/catalog/schemas/brands.schema.js';
export * from '../../features/catalog/schemas/products.schema.js';
export * from '../../features/catalog/schemas/collections.schema.js';
export * from '../../features/catalog/schemas/pricing.schema.js';

// Stock, suppliers and purchase invoices (features/inventory/) —
// docs/reference/inventory_suppliers.md §٢–§٨.
export * from '../../features/inventory/schemas/inventory-enums.schema.js';
export * from '../../features/inventory/schemas/suppliers.schema.js';
export * from '../../features/inventory/schemas/stock.schema.js';
export * from '../../features/inventory/schemas/receipts.schema.js';
export * from '../../features/inventory/schemas/transfers.schema.js';
export * from '../../features/inventory/schemas/returns.schema.js';

// ما يطلبه الزبون وليس على الرف (features/storefront/) —
// docs/reference/store_system.md §٨.
export * from '../../features/storefront/schemas/demand.schema.js';

// العروض والتخفيضات (features/promotions/) — docs/reference/store_system.md §٥.
export * from '../../features/promotions/schemas/promotions.schema.js';

// نقطة البيع والفاتورة (features/sales/) — docs/reference/orders_delivery.md §الفوترة.
export * from '../../features/sales/schemas/sales.schema.js';

// نقطة البيع والفاتورة (features/sales/) — docs/reference/orders_delivery.md §الفوترة.
export * from '../../features/sales/schemas/sales.schema.js';
