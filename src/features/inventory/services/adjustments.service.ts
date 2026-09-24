import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { paginated, type Paginated, type PaginationParams } from '../../../core/pagination/pagination.js';
import { INVENTORY_AUDIT, inventoryTarget } from '../audit-actions.js';
import type { AdjustmentBody, AdjustmentsFilterQuery, WireAdjustment } from '../dtos/stock.dto.js';
import * as stockRepository from '../repositories/stock.repository.js';
import type { StockAdjustmentRow } from '../schemas/stock.schema.js';
import { adjustmentValue, needsApproval } from './stock-rules.js';
import { getSettings, nextNumber, postMovements } from './stock.service.js';

/**
 * Stock leaving without a sale — damage, loss, expiry, a sample given away
 * (inventory_suppliers.md §٨).
 *
 * Small values post at once; above the configured value the document waits
 * for `inventory.approve`. The split exists because the alternative — asking a
 * manager about every broken pen — teaches everyone to approve without
 * looking, which is the same as having no approval at all.
 */

const APPROVE = 'inventory.approve';

async function wire(row: StockAdjustmentRow): Promise<WireAdjustment> {
  const lines = await stockRepository.findAdjustmentLines(row.id);
  return {
    id: row.id,
    branch_id: row.branch_id,
    number: row.number,
    reason: row.reason,
    note: row.note,
    status: row.status,
    total_value_syp: Number(row.total_value_syp),
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null,
    lines: lines.map((line) => ({
      variant_id: line.variant_id,
      sku: line.sku,
      product_name_ar: line.product_name_ar,
      qty_base: Number(line.qty_base),
      unit_cost_syp: Number(line.unit_cost_syp),
    })),
  };
}

export async function createAdjustment(actor: RequestActorContext, body: AdjustmentBody): Promise<WireAdjustment> {
  const variantIds = [...new Set(body.lines.map((line) => line.variant_id))];
  const variants = await stockRepository.findLiveVariants(variantIds);
  for (const id of variantIds) {
    if (!variants.some((v) => v.variant_id === id))
      throw new BusinessError(422, 'Unknown variant on a line', 'adjustment_variant_unknown', { variant_id: id });
  }
  // Valued at the average of the moment (§٨): the number a manager approves is
  // the one the stock was worth when it went, not when the paper was signed.
  const balances = await stockRepository.findBalancesOf(body.branch_id, variantIds);
  const lines = body.lines.map((line) => ({
    variant_id: line.variant_id,
    qty_base: line.qty_base,
    unit_cost_syp: Number(balances.find((b) => b.variant_id === line.variant_id)?.avg_cost_syp ?? 0),
  }));
  const value = adjustmentValue(lines.map((line) => ({ qtyBase: line.qty_base, unitCostSyp: line.unit_cost_syp })));
  const settings = await getSettings();
  const pending = needsApproval(value, settings.approval_threshold_syp);

  const id = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, body.branch_id, 'adjustment', 'DMG');
    const row = await stockRepository.insertAdjustment(
      tx,
      {
        branch_id: body.branch_id,
        number,
        reason: body.reason,
        note: body.note,
        status: pending ? 'pending_approval' : 'posted',
        total_value_syp: value,
      },
      actor.userId,
    );
    await stockRepository.insertAdjustmentLines(tx, row.id, lines);
    // Only a posted document touches stock. A pending one is a request, and
    // stock that left "pending" would be counted twice until someone decided.
    if (!pending) await post(tx, row.id, body.branch_id, lines, actor.userId, body.reason);
    return row.id;
  });

  await recordAudit(actor, INVENTORY_AUDIT.adjustmentCreate, inventoryTarget.adjustment(id), null, {
    branch_id: body.branch_id,
    reason: body.reason,
    total_value_syp: value,
    status: pending ? 'pending_approval' : 'posted',
  });
  return getAdjustment(id);
}

async function post(
  tx: stockRepository.Exec,
  adjustmentId: number,
  branchId: number,
  lines: { variant_id: number; qty_base: number }[],
  userId: number,
  reason: string,
): Promise<void> {
  await postMovements(tx, {
    branchId,
    // Every reason posts as `damage`: the ledger records that stock left
    // without a sale, and *why* lives on the document it points at.
    type: 'damage',
    docType: 'adjustment',
    docId: adjustmentId,
    userId,
    lines: lines.map((line) => ({ variantId: line.variant_id, qtyBase: -line.qty_base, note: reason })),
  });
}

export async function getAdjustment(id: number): Promise<WireAdjustment> {
  const row = await stockRepository.findAdjustmentById(id);
  if (!row) throw new NotFoundError('Adjustment not found');
  return wire(row);
}

export async function listAdjustments(
  params: PaginationParams,
  filter: AdjustmentsFilterQuery,
): Promise<Paginated<WireAdjustment>> {
  const { rows, total } = await stockRepository.findAdjustments(params, {
    branchId: filter.branch_id,
    status: filter.status,
  });
  return paginated(await Promise.all(rows.map(wire)), total, params);
}

/**
 * Approving posts the movements; rejecting closes the document and touches
 * nothing. Either way the decision needs `inventory.approve` **at that
 * branch** — the scope the route guard cannot check, because it depends on
 * which branch's paper this is.
 */
export async function decideAdjustment(
  actor: RequestActorContext,
  id: number,
  approve: boolean,
): Promise<WireAdjustment> {
  const row = await stockRepository.findAdjustmentById(id);
  if (!row) throw new NotFoundError('Adjustment not found');
  if (row.status !== 'pending_approval')
    throw new BusinessError(409, 'This adjustment was already decided', 'adjustment_not_pending', {
      status: row.status,
    });
  if (!(await holdsPermissionAt(actor.userId, APPROVE, row.branch_id)))
    throw new BusinessError(403, 'No approval permission at this branch', 'inventory_scope_denied');

  const lines = await stockRepository.findAdjustmentLines(id);
  await db.transaction(async (tx) => {
    await stockRepository.decideAdjustment(tx, id, approve ? 'posted' : 'rejected', actor.userId);
    if (approve)
      await post(
        tx,
        id,
        row.branch_id,
        lines.map((line) => ({ variant_id: line.variant_id, qty_base: Number(line.qty_base) })),
        actor.userId,
        row.reason,
      );
  });
  await recordAudit(
    actor,
    approve ? INVENTORY_AUDIT.adjustmentApprove : INVENTORY_AUDIT.adjustmentReject,
    inventoryTarget.adjustment(id),
    { status: row.status },
    { status: approve ? 'posted' : 'rejected' },
  );
  return getAdjustment(id);
}
