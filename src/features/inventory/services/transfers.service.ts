import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { paginated, type Paginated, type PaginationParams } from '../../../core/pagination/pagination.js';
import { INVENTORY_AUDIT, inventoryTarget } from '../audit-actions.js';
import type { ReceiveTransferBody, TransferBody, WireTransfer } from '../dtos/transfers.dto.js';
import * as stockRepository from '../repositories/stock.repository.js';
import * as transfersRepository from '../repositories/transfers.repository.js';
import type { StockTransferRow, TransferStatus } from '../schemas/transfers.schema.js';
import { canMove, compareShipment, nextStates } from './transfer-rules.js';
import { nextNumber, postMovements } from './stock.service.js';

/**
 * Moving stock between branches — inventory_suppliers.md §٤.
 *
 * The needing branch asks, the sending branch approves and ships, the
 * receiving branch counts what actually arrived. Between shipping and
 * receiving the goods belong to **neither** balance: counted at the sender
 * they would be sold twice, counted at the receiver they would be sold before
 * they exist there.
 */

const TRANSFER = 'inventory.transfer';

async function assertAt(actor: RequestActorContext, branchId: number): Promise<void> {
  if (!(await holdsPermissionAt(actor.userId, TRANSFER, branchId)))
    throw new BusinessError(403, 'No transfer permission at this branch', 'transfer_scope_denied');
}

async function wire(row: StockTransferRow): Promise<WireTransfer> {
  const [lines, names] = await Promise.all([
    transfersRepository.findTransferLines(row.id),
    transfersRepository.findBranchNames([row.from_branch_id, row.to_branch_id]),
  ]);
  return {
    id: row.id,
    number: row.number,
    from_branch_id: row.from_branch_id,
    from_branch_name: names.get(row.from_branch_id) ?? '',
    to_branch_id: row.to_branch_id,
    to_branch_name: names.get(row.to_branch_id) ?? '',
    status: row.status,
    note: row.note,
    resolution: row.resolution,
    resolution_note: row.resolution_note,
    shipped_at: row.shipped_at?.toISOString() ?? null,
    received_at: row.received_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    // The states this document may still reach — the screen offers exactly
    // these, instead of keeping a second copy of the rules that drifts.
    next_states: nextStates(row.status),
    lines: lines.map((line) => ({
      id: line.id,
      variant_id: line.variant_id,
      sku: line.sku,
      product_name_ar: line.product_name_ar,
      qty_requested: Number(line.qty_requested),
      qty_shipped: line.qty_shipped === null ? null : Number(line.qty_shipped),
      qty_received: line.qty_received === null ? null : Number(line.qty_received),
    })),
  };
}

async function require_(id: number): Promise<StockTransferRow> {
  const row = await transfersRepository.findTransferById(id);
  if (!row) throw new NotFoundError('Transfer not found');
  return row;
}

function assertCanMove(row: StockTransferRow, to: TransferStatus): void {
  if (!canMove(row.status, to))
    throw new BusinessError(409, `A transfer cannot go from ${row.status} to ${to}`, 'transfer_state_invalid', {
      status: row.status,
    });
}

/**
 * A request from the receiving branch, or — for someone unrestricted — a
 * direct order that starts already approved (§٤). The administration moving
 * its own goods does not need the sending branch's permission.
 */
export async function createTransfer(actor: RequestActorContext, body: TransferBody): Promise<WireTransfer> {
  if (body.from_branch_id === body.to_branch_id)
    throw new BusinessError(422, 'A transfer needs two different branches', 'transfer_same_branch');
  const direct = await holdsPermissionAt(actor.userId, TRANSFER, null);
  if (!direct) await assertAt(actor, body.to_branch_id);

  const id = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, body.from_branch_id, 'transfer', 'TRF');
    const row = await transfersRepository.insertTransfer(tx, {
      number,
      from_branch_id: body.from_branch_id,
      to_branch_id: body.to_branch_id,
      status: direct ? 'approved' : 'requested',
      note: body.note ?? null,
      requested_by_user_id: actor.userId,
      approved_by_user_id: direct ? actor.userId : null,
    });
    await transfersRepository.insertTransferLines(tx, row.id, body.lines);
    return row.id;
  });
  await recordAudit(actor, INVENTORY_AUDIT.transferCreate, inventoryTarget.transfer(id), null, {
    from_branch_id: body.from_branch_id,
    to_branch_id: body.to_branch_id,
    direct,
  });
  return getTransfer(id);
}

/** The sending branch decides: it is their stock. */
export async function decideTransfer(
  actor: RequestActorContext,
  id: number,
  approve: boolean,
): Promise<WireTransfer> {
  const row = await require_(id);
  assertCanMove(row, approve ? 'approved' : 'rejected');
  await assertAt(actor, row.from_branch_id);
  await transfersRepository.updateTransfer(db, id, {
    status: approve ? 'approved' : 'rejected',
    approved_by_user_id: actor.userId,
  });
  await recordAudit(
    actor,
    approve ? INVENTORY_AUDIT.transferApprove : INVENTORY_AUDIT.transferReject,
    inventoryTarget.transfer(id),
    { status: row.status },
    { status: approve ? 'approved' : 'rejected' },
  );
  return getTransfer(id);
}

/**
 * Shipping takes the goods out of the sender at **the sender's own cost**
 * (§٣): a transfer is not a sale, and letting the receiver book a different
 * cost would invent profit inside the company.
 */
export async function shipTransfer(
  actor: RequestActorContext,
  id: number,
  body: ReceiveTransferBody,
): Promise<WireTransfer> {
  const row = await require_(id);
  assertCanMove(row, 'in_transit');
  await assertAt(actor, row.from_branch_id);
  const lines = await transfersRepository.findTransferLines(id);
  const balances = await stockRepository.findBalancesOf(row.from_branch_id, lines.map((line) => line.variant_id));

  await db.transaction(async (tx) => {
    const posted: { variantId: number; qtyBase: number; cost: { syp: number; usd: number } }[] = [];
    for (const line of lines) {
      const asked = Number(line.qty_requested);
      const shipped = body.lines.find((l) => l.variant_id === line.variant_id)?.qty ?? asked;
      if (shipped <= 0) continue;
      const balance = balances.find((b) => b.variant_id === line.variant_id);
      const cost = {
        syp: Number(balance?.avg_cost_syp ?? 0),
        usd: Number(balance?.avg_cost_usd ?? 0),
      };
      await transfersRepository.setShippedLine(tx, line.id, {
        qty_shipped: shipped,
        unit_cost_syp: cost.syp,
        unit_cost_usd: cost.usd,
      });
      posted.push({ variantId: line.variant_id, qtyBase: -shipped, cost });
    }
    await postMovements(tx, {
      branchId: row.from_branch_id,
      type: 'transfer_out',
      docType: 'transfer',
      docId: id,
      userId: actor.userId,
      lines: posted.map((line) => ({ variantId: line.variantId, qtyBase: line.qtyBase })),
    });
    await transfersRepository.updateTransfer(tx, id, {
      status: 'in_transit',
      shipped_by_user_id: actor.userId,
      shipped_at: new Date(),
    });
  });
  await recordAudit(actor, INVENTORY_AUDIT.transferShip, inventoryTarget.transfer(id), { status: row.status }, {
    status: 'in_transit',
  });
  return getTransfer(id);
}

/**
 * Receiving books what **actually arrived**, not what was shipped. A gap is
 * not swallowed: the transfer stays `received_with_discrepancy` until a
 * manager says what happened to the missing goods (§٤).
 */
export async function receiveTransfer(
  actor: RequestActorContext,
  id: number,
  body: ReceiveTransferBody,
): Promise<WireTransfer> {
  const row = await require_(id);
  if (row.status !== 'in_transit')
    throw new BusinessError(409, 'Only goods in transit can be received', 'transfer_state_invalid', {
      status: row.status,
    });
  await assertAt(actor, row.to_branch_id);
  const lines = await transfersRepository.findTransferLines(id);

  const outcome = compareShipment(
    lines.map((line) => ({
      variantId: line.variant_id,
      shipped: Number(line.qty_shipped ?? 0),
      received: body.lines.find((l) => l.variant_id === line.variant_id)?.qty ?? Number(line.qty_shipped ?? 0),
    })),
  );

  await db.transaction(async (tx) => {
    for (const line of lines) {
      const received = outcome.lines.find((l) => l.variantId === line.variant_id)?.received ?? 0;
      await transfersRepository.setReceivedLine(tx, line.id, received);
    }
    await postMovements(tx, {
      branchId: row.to_branch_id,
      type: 'transfer_in',
      docType: 'transfer',
      docId: id,
      userId: actor.userId,
      lines: outcome.lines
        .filter((line) => line.received > 0)
        .map((line) => {
          const source = lines.find((l) => l.variant_id === line.variantId)!;
          return {
            variantId: line.variantId,
            qtyBase: line.received,
            cost: { syp: Number(source.unit_cost_syp ?? 0), usd: Number(source.unit_cost_usd ?? 0) },
          };
        }),
    });
    await transfersRepository.updateTransfer(tx, id, {
      status: outcome.hasDiscrepancy ? 'received_with_discrepancy' : 'received',
      received_by_user_id: actor.userId,
      received_at: new Date(),
    });
  });
  await recordAudit(actor, INVENTORY_AUDIT.transferReceive, inventoryTarget.transfer(id), { status: row.status }, {
    status: outcome.hasDiscrepancy ? 'received_with_discrepancy' : 'received',
    discrepancy: outcome.hasDiscrepancy,
  });
  return getTransfer(id);
}

/**
 * Settling a gap. `loss` writes the missing goods off at the **sender** —
 * they left that branch and never arrived anywhere, so the loss belongs where
 * the stock was. `returned` puts them back on the sender's shelf, which is
 * what a short shipment (never actually sent) means.
 */
export async function resolveTransfer(
  actor: RequestActorContext,
  id: number,
  body: { resolution: 'loss' | 'returned'; note?: string | null },
): Promise<WireTransfer> {
  const row = await require_(id);
  if (row.status !== 'received_with_discrepancy')
    throw new BusinessError(409, 'This transfer has no open discrepancy', 'transfer_no_discrepancy', {
      status: row.status,
    });
  await assertAt(actor, row.from_branch_id);
  const lines = await transfersRepository.findTransferLines(id);
  const missing = lines
    .map((line) => ({
      variantId: line.variant_id,
      qty: Number(line.qty_shipped ?? 0) - Number(line.qty_received ?? 0),
      cost: { syp: Number(line.unit_cost_syp ?? 0), usd: Number(line.unit_cost_usd ?? 0) },
    }))
    .filter((line) => line.qty > 0);

  await db.transaction(async (tx) => {
    if (body.resolution === 'returned' && missing.length > 0) {
      await postMovements(tx, {
        branchId: row.from_branch_id,
        type: 'transfer_in',
        docType: 'transfer',
        docId: id,
        userId: actor.userId,
        lines: missing.map((line) => ({ variantId: line.variantId, qtyBase: line.qty, cost: line.cost })),
      });
    }
    // `loss` posts nothing: the goods already left the sender when it shipped,
    // and they never reached the receiver. The write-off is that absence —
    // posting a second movement would remove the same stock twice.
    await transfersRepository.updateTransfer(tx, id, {
      status: 'closed',
      resolution: body.resolution,
      resolution_note: body.note ?? null,
    });
  });
  await recordAudit(actor, INVENTORY_AUDIT.transferResolve, inventoryTarget.transfer(id), { status: row.status }, {
    status: 'closed',
    resolution: body.resolution,
  });
  return getTransfer(id);
}

export async function closeTransfer(actor: RequestActorContext, id: number): Promise<WireTransfer> {
  const row = await require_(id);
  assertCanMove(row, 'closed');
  await assertAt(actor, row.from_branch_id);
  await transfersRepository.updateTransfer(db, id, { status: 'closed' });
  await recordAudit(actor, INVENTORY_AUDIT.transferClose, inventoryTarget.transfer(id), { status: row.status }, {
    status: 'closed',
  });
  return getTransfer(id);
}

export async function getTransfer(id: number): Promise<WireTransfer> {
  return wire(await require_(id));
}

export async function listTransfers(
  params: PaginationParams,
  filter: { branch_id?: number; status?: TransferStatus },
): Promise<Paginated<WireTransfer>> {
  const { rows, total } = await transfersRepository.findTransfers(params, {
    branchId: filter.branch_id,
    status: filter.status,
  });
  return paginated(await Promise.all(rows.map(wire)), total, params);
}
