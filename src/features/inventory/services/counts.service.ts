import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { paginated, type Paginated, type PaginationParams } from '../../../core/pagination/pagination.js';
import { INVENTORY_AUDIT, inventoryTarget } from '../audit-actions.js';
import type { CountBody, CountLineBody, WireCount, WireCountLine } from '../dtos/transfers.dto.js';
import * as stockRepository from '../repositories/stock.repository.js';
import * as transfersRepository from '../repositories/transfers.repository.js';
import type { CountStatus, StockCountRow } from '../schemas/transfers.schema.js';
import { countDifferences } from './transfer-rules.js';
import { getSettings, nextNumber, postMovements } from './stock.service.js';
import { needsApproval } from './stock-rules.js';

/**
 * Stocktaking — inventory_suppliers.md §٥.
 *
 * **Blind**: the counter never sees what the system expects, so the count is
 * a count and not a confirmation. The branch keeps selling while it runs, so
 * each line records the system quantity **at the moment it was scanned**; the
 * difference is measured against that instant, not against a snapshot that
 * was already stale by the second item.
 */

const COUNT = 'inventory.count';
const APPROVE = 'inventory.approve';

/**
 * Two guards rather than one with a key argument: `check:messages` reads the
 * literal at the throw site, and a variable there hides the refusal's text
 * from the check that makes sure an Arabic reader sees Arabic.
 */
async function assertCanCount(actor: RequestActorContext, branchId: number): Promise<void> {
  if (!(await holdsPermissionAt(actor.userId, COUNT, branchId)))
    throw new BusinessError(403, 'No stocktake permission at this branch', 'count_scope_denied');
}

async function assertCanApprove(actor: RequestActorContext, branchId: number): Promise<void> {
  if (!(await holdsPermissionAt(actor.userId, APPROVE, branchId)))
    throw new BusinessError(403, 'No approval permission at this branch', 'inventory_scope_denied');
}

async function wire(row: StockCountRow): Promise<WireCount> {
  const lines = await transfersRepository.findCountLines(row.id);
  const open = row.status === 'open';
  const wireLines: WireCountLine[] = lines.map((line) => ({
    variant_id: line.variant_id,
    sku: line.sku,
    product_name_ar: line.product_name_ar,
    counted_qty: Number(line.counted_qty),
    // Hidden while open — that is what "blind" means, and sending it "just
    // for the UI" would put the expected number one inspector away.
    system_qty: open ? null : Number(line.system_qty),
    diff: open ? null : Number((Number(line.counted_qty) - Number(line.system_qty)).toFixed(3)),
    counted_at: line.counted_at.toISOString(),
  }));
  return {
    id: row.id,
    number: row.number,
    branch_id: row.branch_id,
    scope: row.scope,
    category_id: row.category_id,
    status: row.status,
    note: row.note,
    diff_value_syp: row.diff_value_syp === null ? null : Number(row.diff_value_syp),
    counted_lines: lines.length,
    created_at: row.created_at.toISOString(),
    closed_at: row.closed_at?.toISOString() ?? null,
    lines: wireLines,
  };
}

async function require_(id: number): Promise<StockCountRow> {
  const row = await transfersRepository.findCountById(id);
  if (!row) throw new NotFoundError('Count not found');
  return row;
}

export async function openCount(actor: RequestActorContext, body: CountBody): Promise<WireCount> {
  await assertCanCount(actor, body.branch_id);
  const id = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, body.branch_id, 'count', 'CNT');
    const row = await transfersRepository.insertCount(tx, {
      number,
      branch_id: body.branch_id,
      scope: body.scope,
      category_id: body.category_id ?? null,
      status: 'open',
      note: body.note ?? null,
      started_by_user_id: actor.userId,
    });
    return row.id;
  });
  await recordAudit(actor, INVENTORY_AUDIT.countOpen, inventoryTarget.count(id), null, {
    branch_id: body.branch_id,
    scope: body.scope,
  });
  return getCount(id);
}

/**
 * One scanned item. A second scan of the same item **replaces** the first: a
 * shelf counted twice must not read as double the stock, and the correction
 * is the whole reason someone scans it again.
 */
export async function recordCountLine(
  actor: RequestActorContext,
  id: number,
  body: CountLineBody,
): Promise<{ recorded: true; counted_lines: number }> {
  const row = await require_(id);
  if (row.status !== 'open')
    throw new BusinessError(409, 'This count is closed', 'count_not_open', { status: row.status });
  await assertCanCount(actor, row.branch_id);
  const [balance] = await stockRepository.findBalancesOf(row.branch_id, [body.variant_id]);
  await transfersRepository.upsertCountLine(
    {
      count_id: id,
      variant_id: body.variant_id,
      counted_qty: body.counted_qty,
      system_qty: Number(balance?.on_hand ?? 0),
      unit_cost_syp: Number(balance?.avg_cost_syp ?? 0),
    },
    actor.userId,
  );
  const lines = await transfersRepository.findCountLines(id);
  // The response says how many lines are in, and nothing about the system's
  // numbers: an answer carrying the difference would end the blind count.
  return { recorded: true, counted_lines: lines.length };
}

/**
 * Closing compares and settles. Differences worth more than the configured
 * value wait for `inventory.approve`; below it they post with the close —
 * the same split as damage (§٨), for the same reason.
 */
export async function closeCount(actor: RequestActorContext, id: number): Promise<WireCount> {
  const row = await require_(id);
  if (row.status !== 'open')
    throw new BusinessError(409, 'This count is already closed', 'count_not_open', { status: row.status });
  await assertCanCount(actor, row.branch_id);

  const lines = await transfersRepository.findCountLines(id);
  const { diffs, valueSyp } = countDifferences(
    lines.map((line) => ({
      variantId: line.variant_id,
      counted: Number(line.counted_qty),
      system: Number(line.system_qty),
      unitCostSyp: Number(line.unit_cost_syp),
    })),
  );
  const settings = await getSettings();
  const pending = needsApproval(valueSyp, settings.approval_threshold_syp);

  await db.transaction(async (tx) => {
    await transfersRepository.updateCount(tx, id, {
      status: pending ? 'pending_approval' : 'closed',
      diff_value_syp: String(valueSyp),
      closed_at: pending ? null : new Date(),
      decided_by_user_id: pending ? null : actor.userId,
    });
    if (!pending) await postDiffs(tx, id, row.branch_id, diffs, actor.userId);
  });
  await recordAudit(actor, INVENTORY_AUDIT.countClose, inventoryTarget.count(id), { status: row.status }, {
    status: pending ? 'pending_approval' : 'closed',
    diff_value_syp: valueSyp,
    diff_lines: diffs.length,
  });
  return getCount(id);
}

async function postDiffs(
  tx: stockRepository.Exec,
  countId: number,
  branchId: number,
  diffs: { variantId: number; diff: number }[],
  userId: number,
): Promise<void> {
  if (diffs.length === 0) return;
  await postMovements(tx, {
    branchId,
    type: 'count_adjustment',
    docType: 'count',
    docId: countId,
    userId,
    // The difference itself is the movement: a shelf holding more than the
    // books adds, one holding less removes. A surplus carries no new cost —
    // it was always ours, the paper was simply wrong.
    lines: diffs.map((d) => ({ variantId: d.variantId, qtyBase: d.diff })),
  });
}

export async function decideCount(actor: RequestActorContext, id: number, approve: boolean): Promise<WireCount> {
  const row = await require_(id);
  if (row.status !== 'pending_approval')
    throw new BusinessError(409, 'This count is not waiting for a decision', 'count_not_pending', {
      status: row.status,
    });
  await assertCanApprove(actor, row.branch_id);
  const lines = await transfersRepository.findCountLines(id);
  const { diffs } = countDifferences(
    lines.map((line) => ({
      variantId: line.variant_id,
      counted: Number(line.counted_qty),
      system: Number(line.system_qty),
      unitCostSyp: Number(line.unit_cost_syp),
    })),
  );
  await db.transaction(async (tx) => {
    await transfersRepository.updateCount(tx, id, {
      status: approve ? 'closed' : 'cancelled',
      closed_at: new Date(),
      decided_by_user_id: actor.userId,
    });
    if (approve) await postDiffs(tx, id, row.branch_id, diffs, actor.userId);
  });
  await recordAudit(
    actor,
    approve ? INVENTORY_AUDIT.countApprove : INVENTORY_AUDIT.countReject,
    inventoryTarget.count(id),
    { status: row.status },
    { status: approve ? 'closed' : 'cancelled' },
  );
  return getCount(id);
}

export async function getCount(id: number): Promise<WireCount> {
  return wire(await require_(id));
}

export async function listCounts(
  params: PaginationParams,
  filter: { branch_id?: number; status?: CountStatus },
): Promise<Paginated<WireCount>> {
  const { rows, total } = await transfersRepository.findCounts(params, {
    branchId: filter.branch_id,
    status: filter.status,
  });
  return paginated(await Promise.all(rows.map(wire)), total, params);
}
