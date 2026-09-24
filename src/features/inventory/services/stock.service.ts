import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import { paginated, type Paginated, type PaginationParams } from '../../../core/pagination/pagination.js';
import { INVENTORY_AUDIT, inventoryTarget } from '../audit-actions.js';
import type { InventoryDocType } from '../schemas/inventory-enums.schema.js';
import type {
  DocumentItemsQuery,
  MovementsFilterQuery,
  StockFilterQuery,
  WireDocumentItem,
  WireInventorySettings,
  WireMovement,
  WireStockRow,
  WireStockSignals,
} from '../dtos/stock.dto.js';
import * as stockRepository from '../repositories/stock.repository.js';
import { applyIssue, applyReceipt, available, stockFlag, suggestThreshold, type CostPair } from './stock-rules.js';

/**
 * Stock — the ledger is the record, the balance is its cache
 * (inventory_suppliers.md §٢). Everything that moves quantity goes through
 * [postMovements] so that no path can write one without the other.
 */

export const DEFAULT_APPROVAL_THRESHOLD = 100_000;
const DEFAULT_EXPIRY_DAYS = 30;

export async function getSettings(): Promise<WireInventorySettings> {
  const [row, branches] = await Promise.all([
    stockRepository.findSettings(),
    stockRepository.findLiveBranches(),
  ]);
  return {
    approval_threshold_syp: row ? Number(row.approval_threshold_syp) : DEFAULT_APPROVAL_THRESHOLD,
    expiry_alert_days: row?.expiry_alert_days ?? DEFAULT_EXPIRY_DAYS,
    branches,
  };
}

export async function setSettings(
  actor: RequestActorContext,
  body: { approval_threshold_syp: number; expiry_alert_days: number },
): Promise<WireInventorySettings> {
  const before = await getSettings();
  await stockRepository.saveSettings(body, actor.userId);
  await recordAudit(actor, INVENTORY_AUDIT.settingsSet, inventoryTarget.settings(), before, body);
  return getSettings();
}

export interface PostedLine {
  variantId: number;
  /** Signed, in base units: in is positive, out is negative. */
  qtyBase: number;
  /** The cost this line carries — receipts only; an issue is valued by the average. */
  cost?: CostPair;
  note?: string | null;
}

/**
 * Writes movements and their balances **in one transaction**, with each
 * balance row locked while it is read and written.
 *
 * The lock is what makes "the last piece" safe: without it two writers read
 * the same on-hand, and both save a balance computed from a world that no
 * longer exists — the ledger would then disagree with its own cache.
 *
 * Costing (§٣): a receipt moves the weighted average, an issue never does.
 */
export async function postMovements(
  exec: stockRepository.Exec,
  input: {
    branchId: number;
    type: Parameters<typeof stockRepository.insertMovements>[1][number]['type'];
    docType: InventoryDocType | null;
    docId: number | null;
    lines: PostedLine[];
    userId: number;
  },
): Promise<void> {
  const movements: Parameters<typeof stockRepository.insertMovements>[1] = [];
  for (const line of input.lines) {
    const current = await stockRepository.lockBalance(exec, input.branchId, line.variantId);
    const balance = {
      onHand: current ? Number(current.on_hand) : 0,
      avg: {
        syp: current ? Number(current.avg_cost_syp) : 0,
        usd: current ? Number(current.avg_cost_usd) : 0,
      },
    };
    const next =
      line.qtyBase >= 0 && line.cost
        ? applyReceipt(balance, line.qtyBase, line.cost)
        : applyIssue(balance, Math.abs(line.qtyBase));
    await stockRepository.upsertBalance(exec, input.branchId, line.variantId, {
      on_hand: next.onHand,
      avg_cost_syp: next.avg.syp,
      avg_cost_usd: next.avg.usd,
    });
    if (line.qtyBase < 0) await stockRepository.consumeLayers(exec, input.branchId, line.variantId, Math.abs(line.qtyBase));
    movements.push({
      branch_id: input.branchId,
      variant_id: line.variantId,
      type: input.type,
      qty_base: line.qtyBase,
      // An issue carries the average it left at, so a movement can be valued
      // years later without replaying every receipt before it.
      unit_cost_syp: line.cost?.syp ?? balance.avg.syp,
      unit_cost_usd: line.cost?.usd ?? balance.avg.usd,
      source_doc_type: input.docType,
      source_doc_id: input.docId,
      note: line.note ?? null,
    });
  }
  await stockRepository.insertMovements(exec, movements, input.userId);
}

// ── Reading ─────────────────────────────────────────────────────────────────

function toWireRow(row: stockRepository.BalanceRow): WireStockRow {
  const onHand = Number(row.on_hand);
  const reserved = Number(row.reserved);
  const threshold = row.reorder_threshold === null ? null : Number(row.reorder_threshold);
  return {
    variant_id: row.variant_id,
    product_id: row.product_id,
    product_name_ar: row.product_name_ar,
    product_name_en: row.product_name_en,
    sku: row.sku,
    on_hand: onHand,
    reserved,
    available: available(onHand, reserved),
    avg_cost_syp: Number(row.avg_cost_syp),
    avg_cost_usd: Number(row.avg_cost_usd),
    reorder_threshold: threshold,
    flag: stockFlag(onHand, reserved, threshold),
  };
}

/**
 * What a document line may point at. Capped at 25 rows on purpose: this
 * answers a typed search, and a picker that silently stops at a page boundary
 * reads as «لا يوجد» to whoever typed one letter too few.
 */
export async function searchDocumentItems(query: DocumentItemsQuery): Promise<WireDocumentItem[]> {
  const rows = await stockRepository.searchVariantsForDocument(
    normalizeArabic(query.search),
    query.branch_id,
    25,
  );
  const units = await stockRepository.findVariantUnitOptions(rows.map((row) => row.variant_id));
  return rows.map((row) => ({
    variant_id: row.variant_id,
    sku: row.sku,
    product_name_ar: row.product_name_ar,
    base_unit_id: row.base_unit_id,
    on_hand: Number(row.on_hand ?? 0),
    units: units
      .filter((unit) => unit.variant_id === row.variant_id)
      .map((unit) => ({
        unit_id: unit.unit_id,
        unit_name_ar: unit.unit_name_ar,
        factor: Number(unit.factor),
        is_base: unit.is_base,
      })),
  }));
}

export async function listStock(
  params: PaginationParams,
  filter: StockFilterQuery,
): Promise<Paginated<WireStockRow>> {
  // A flag filter is applied after reading, because the flag is a rule (§٨)
  // and not a column: duplicating it in SQL is the second implementation that
  // disagrees with the first the day the rule changes.
  if (filter.flag) {
    const all = (await stockRepository.findAllBalances(filter.branch_id)).map(toWireRow);
    const search = filter.search ? normalizeArabic(filter.search) : null;
    const matching = all.filter(
      (row) =>
        (filter.flag === 'low' ? row.flag !== 'ok' : row.flag === filter.flag) &&
        (search === null || normalizeArabic(row.product_name_ar).includes(search)),
    );
    const page = matching.slice(params.offset, params.offset + params.limit);
    return paginated(page, matching.length, params);
  }
  const { rows, total } = await stockRepository.findBalances(filter.branch_id, params, {
    search: filter.search ? normalizeArabic(filter.search) : undefined,
  });
  return paginated(rows.map(toWireRow), total, params);
}

export async function listMovements(
  params: PaginationParams,
  filter: MovementsFilterQuery,
): Promise<Paginated<WireMovement>> {
  const { rows, total } = await stockRepository.findMovements(filter.branch_id, params, {
    variantId: filter.variant_id,
  });
  const wire = rows.map((row) => ({
    id: row.id,
    variant_id: row.variant_id,
    sku: row.sku,
    product_name_ar: row.product_name_ar,
    type: row.type,
    qty_base: Number(row.qty_base),
    unit_cost_syp: row.unit_cost_syp === null ? null : Number(row.unit_cost_syp),
    source_doc_type: row.source_doc_type,
    source_doc_id: row.source_doc_id,
    note: row.note,
    created_at: row.created_at.toISOString(),
    created_by: row.first_name ? `${row.first_name} ${row.last_name ?? ''}`.trim() : null,
  }));
  return paginated(wire, total, params);
}

export async function setReorderThreshold(
  actor: RequestActorContext,
  variantId: number,
  body: { branch_id: number; threshold: number | null },
): Promise<WireStockRow> {
  await stockRepository.setReorderThreshold(body.branch_id, variantId, body.threshold);
  await recordAudit(actor, INVENTORY_AUDIT.thresholdSet, inventoryTarget.variant(variantId), null, {
    branch_id: body.branch_id,
    threshold: body.threshold,
  });
  const [row] = await stockRepository.findBalancesOf(body.branch_id, [variantId]);
  if (!row) throw new NotFoundError('Stock row not found');
  const balances = await stockRepository.findAllBalances(body.branch_id);
  const found = balances.find((b) => b.variant_id === variantId);
  if (!found) throw new NotFoundError('Stock row not found');
  return toWireRow(found);
}

/**
 * A threshold suggested from this branch's own sales (§٨) — `null` until
 * there is enough history, because a number from three days of sales would be
 * trusted exactly as much as one from a year.
 */
export async function suggestReorderThreshold(
  branchId: number,
  variantId: number,
): Promise<{ suggestion: number | null; days: number; sold_base: number }> {
  const days = 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sold = await stockRepository.sumSoldSince(branchId, variantId, since);
  return { suggestion: suggestThreshold(sold, days), days, sold_base: sold };
}

/** What a branch manager needs to act on, counted rather than listed. */
export async function getSignals(branchId: number): Promise<WireStockSignals> {
  const settings = await getSettings();
  const [balances, pending, expiring] = await Promise.all([
    stockRepository.findAllBalances(branchId),
    stockRepository.countPendingAdjustments(branchId),
    stockRepository.findExpiring(
      branchId,
      new Date(Date.now() + settings.expiry_alert_days * 24 * 60 * 60 * 1000),
    ),
  ]);
  const rows = balances.map(toWireRow);
  return {
    branch_id: branchId,
    low_count: rows.filter((row) => row.flag === 'low').length,
    out_of_stock_count: rows.filter((row) => row.flag === 'out_of_stock').length,
    negative_count: rows.filter((row) => row.flag === 'negative').length,
    pending_adjustments: pending,
    expiring: expiring.map((layer) => ({
      variant_id: layer.variant_id,
      sku: layer.sku,
      product_name_ar: layer.product_name_ar,
      remaining_base: Number(layer.remaining_base),
      expires_at: layer.expires_at!.toISOString(),
    })),
  };
}

/** `GRN-3-000012` — the branch's own run of numbers for that document type. */
export async function nextNumber(
  exec: stockRepository.Exec,
  branchId: number,
  docType: InventoryDocType,
  prefix: string,
): Promise<string> {
  const next = await stockRepository.nextDocNumber(exec, branchId, docType);
  return `${prefix}-${branchId}-${String(next).padStart(6, '0')}`;
}

/** Shared by the writers: a variant that cannot hold stock must not get a movement. */
export function assertPositive(qty: number): void {
  if (!(qty > 0)) throw new BusinessError(422, 'Quantity must be above zero', 'stock_qty_invalid');
}

export { db };
