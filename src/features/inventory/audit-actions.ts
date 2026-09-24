/**
 * Audit actions for stock and suppliers. Written through the core recorder
 * (`core/audit/audit-recorder.ts`) into the same `audit_log_entries` as every
 * other module — one place where the past lives.
 */
export const INVENTORY_AUDIT = {
  supplierCreate: 'inventory.supplier.create',
  supplierUpdate: 'inventory.supplier.update',
  supplierArchive: 'inventory.supplier.archive',
  supplierUnarchive: 'inventory.supplier.unarchive',
  supplierDelete: 'inventory.supplier.delete',
  receiptPost: 'inventory.receipt.post',
  adjustmentCreate: 'inventory.adjustment.create',
  adjustmentApprove: 'inventory.adjustment.approve',
  adjustmentReject: 'inventory.adjustment.reject',
  transferCreate: 'inventory.transfer.create',
  transferApprove: 'inventory.transfer.approve',
  transferReject: 'inventory.transfer.reject',
  transferShip: 'inventory.transfer.ship',
  transferReceive: 'inventory.transfer.receive',
  transferResolve: 'inventory.transfer.resolve',
  transferClose: 'inventory.transfer.close',
  countOpen: 'inventory.count.open',
  countClose: 'inventory.count.close',
  countApprove: 'inventory.count.approve',
  countReject: 'inventory.count.reject',
  returnCreate: 'inventory.return.create',
  thresholdSet: 'inventory.threshold.set',
  settingsSet: 'inventory.settings.set',
} as const;

/** `target_entity` values — what `EntityHistorySection(targetEntity:)` filters by. */
export const inventoryTarget = {
  supplier: (id: number) => `supplier:${id}`,
  receipt: (id: number) => `purchase_invoice:${id}`,
  adjustment: (id: number) => `stock_adjustment:${id}`,
  transfer: (id: number) => `stock_transfer:${id}`,
  count: (id: number) => `stock_count:${id}`,
  purchaseReturn: (id: number) => `purchase_return:${id}`,
  /** Stock facts are recorded on the variant — "what happened to this item" is the question. */
  variant: (id: number) => `catalog_variant:${id}`,
  settings: () => 'inventory:settings',
} as const;
