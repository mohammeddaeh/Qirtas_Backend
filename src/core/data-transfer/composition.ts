import { clearTransferResources, registerTransferResource } from './registry.js';
import type { TransferResource } from './types.js';

/**
 * The one place an application declares what it can import and export.
 *
 * Called from `app.ts` — the composition root — and **not** by a side-effect
 * import from inside `core/`, so the dependency rule holds: `core/` still
 * imports nothing from `features/`. (`core/openapi/document.ts` predates this
 * and does reach into features; it is the exception, not the pattern to copy.)
 *
 * Registration is idempotent: the list replaces whatever was registered before,
 * because `buildApp()` runs once per integration test file and a throw on the
 * second call would fail the suite for a reason that has nothing to do with
 * what it asserts. A duplicate **name inside one call** still throws — that is
 * a real mistake, not a lifecycle artefact.
 */
export function configureDataTransfer(resources: TransferResource[]): void {
  clearTransferResources();
  for (const resource of resources) {
    registerTransferResource(resource);
  }
}
