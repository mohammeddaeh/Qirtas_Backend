import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { paginated, type Paginated, type PaginationParams } from '../../../core/pagination/pagination.js';
import { INVENTORY_AUDIT, inventoryTarget } from '../audit-actions.js';
import type {
  ReturnBody,
  ReturnsFilterQuery,
  WireReturn,
  WireReturnableLine,
} from '../dtos/returns.dto.js';
import * as receiptsRepository from '../repositories/receipts.repository.js';
import * as returnsRepository from '../repositories/returns.repository.js';
import * as stockRepository from '../repositories/stock.repository.js';
import { returnableBase, returnBlock, returnValue } from './return-rules.js';
import { available } from './stock-rules.js';
import { nextNumber, postMovements } from './stock.service.js';

/**
 * Goods going back to the supplier — inventory_suppliers.md §٧.
 *
 * Two rules hold this together:
 *
 * **It is returned against an invoice.** Not «take 3 off the shelf» — the
 * supplier is credited for what *he* charged, so the cost comes from the line
 * the goods arrived on, whatever the shelf averages to today. That is also
 * what caps the quantity: you cannot send back more of an item than that
 * invoice brought in, minus what already went back on it.
 *
 * **It still has to be on the shelf.** The invoice says what is owed; the
 * balance says what exists. A return of stock that has since been sold would
 * drive the branch negative, and the ledger would carry a lie that no later
 * count can explain.
 */

export async function listReturnable(receiptId: number): Promise<WireReturnableLine[]> {
  const found = await receiptsRepository.findById(receiptId);
  if (!found) throw new NotFoundError('Receipt not found');
  const [lines, returned] = await Promise.all([
    receiptsRepository.findLines(receiptId),
    returnsRepository.returnedByVariant(db, receiptId),
  ]);
  return lines.map((line) => {
    const receivedBase = Number(line.qty_base);
    const returnedBase = returned.get(line.variant_id) ?? 0;
    return {
      variant_id: line.variant_id,
      sku: line.sku,
      product_name_ar: line.product_name_ar,
      unit_name_ar: line.unit_name_ar,
      received_base: receivedBase,
      returned_base: returnedBase,
      returnable_base: returnableBase(receivedBase, returnedBase),
      unit_cost_syp: Number(line.unit_cost_base_syp),
      unit_cost_usd: Number(line.unit_cost_base_usd),
    };
  });
}

export async function createReturn(actor: RequestActorContext, body: ReturnBody): Promise<WireReturn> {
  const found = await receiptsRepository.findById(body.receipt_id);
  if (!found) throw new NotFoundError('Receipt not found');
  const invoice = found.invoice;
  const receiptLines = await receiptsRepository.findLines(body.receipt_id);

  const returnId = await db.transaction(async (tx) => {
    const returned = await returnsRepository.returnedByVariant(tx, body.receipt_id);
    const prepared = [] as {
      variant_id: number;
      qty_base: number;
      unit_cost_syp: number;
      unit_cost_usd: number;
    }[];

    for (const line of body.lines) {
      const source = receiptLines.find((row) => row.variant_id === line.variant_id);
      if (!source)
        throw new BusinessError(422, 'That item is not on this invoice', 'return_not_on_receipt', {
          variant_id: line.variant_id,
        });
      const cap = returnableBase(Number(source.qty_base), returned.get(line.variant_id) ?? 0);
      // The balance is locked before it is read, and stays locked until the
      // movement is posted: two people returning the last box at the same
      // moment must not both be told it is there.
      const balance = await stockRepository.lockBalance(tx, invoice.branch_id, line.variant_id);
      const onHand = available(balance ? Number(balance.on_hand) : 0, balance ? Number(balance.reserved) : 0);
      const block = returnBlock(line.qty_base, cap, onHand);
      if (block === 'exceeds_receipt')
        throw new BusinessError(422, 'More than this invoice brought in', 'return_exceeds_receipt', {
          variant_id: line.variant_id,
          returnable_base: cap,
        });
      if (block === 'exceeds_stock')
        throw new BusinessError(409, 'The branch does not hold that much', 'return_exceeds_stock', {
          variant_id: line.variant_id,
          available: onHand,
        });
      prepared.push({
        variant_id: line.variant_id,
        qty_base: line.qty_base,
        // The cost the goods came in at — §٧. The invoice line stores it per
        // base unit already, so no factor is applied a second time.
        unit_cost_syp: Number(source.unit_cost_base_syp),
        unit_cost_usd: Number(source.unit_cost_base_usd),
      });
    }

    const totalSyp = returnValue(prepared);
    const number = await nextNumber(tx, invoice.branch_id, 'return', 'PRT');
    const doc = await returnsRepository.insertReturn(
      tx,
      {
        number,
        branch_id: invoice.branch_id,
        supplier_id: invoice.supplier_id,
        receipt_id: invoice.id,
        note: body.note,
        total_syp: totalSyp,
      },
      actor.userId,
    );
    await returnsRepository.insertLines(tx, doc.id, prepared);
    await postMovements(tx, {
      branchId: invoice.branch_id,
      type: 'return_to_supplier',
      docType: 'return',
      docId: doc.id,
      userId: actor.userId,
      lines: prepared.map((line) => ({
        variantId: line.variant_id,
        qtyBase: -line.qty_base,
        // The movement carries the invoice cost, not the shelf average: what
        // left is exactly what he sold us. The balance's average is left
        // alone — an issue never rewrites it.
        cost: { syp: line.unit_cost_syp, usd: line.unit_cost_usd },
      })),
    });
    return doc.id;
  });

  await recordAudit(actor, INVENTORY_AUDIT.returnCreate, inventoryTarget.purchaseReturn(returnId), null, {
    receipt_id: body.receipt_id,
    branch_id: invoice.branch_id,
    supplier_id: invoice.supplier_id,
    lines: body.lines.length,
  });
  return getReturn(returnId);
}

export async function getReturn(id: number): Promise<WireReturn> {
  const found = await returnsRepository.findById(id);
  if (!found) throw new NotFoundError('Return not found');
  const lines = await returnsRepository.findLines(id);
  const { doc } = found;
  return {
    id: doc.id,
    number: doc.number,
    branch_id: doc.branch_id,
    branch_name: found.branch_name,
    supplier_id: doc.supplier_id,
    supplier_name: found.supplier_name,
    receipt_id: doc.receipt_id,
    receipt_number: found.receipt_number,
    note: doc.note,
    total_syp: Number(doc.total_syp),
    created_at: doc.created_at.toISOString(),
    created_by: found.first_name ? `${found.first_name} ${found.last_name ?? ''}`.trim() : null,
    lines: lines.map((line) => ({
      variant_id: line.variant_id,
      sku: line.sku,
      product_name_ar: line.product_name_ar,
      qty_base: Number(line.qty_base),
      unit_cost_syp: Number(line.unit_cost_syp),
      line_total_syp: Number((Number(line.qty_base) * Number(line.unit_cost_syp)).toFixed(2)),
    })),
  };
}

export async function listReturns(
  params: PaginationParams,
  filter: ReturnsFilterQuery,
): Promise<Paginated<Omit<WireReturn, 'lines' | 'created_by'>>> {
  const { rows, total } = await returnsRepository.findMany(params, {
    branchId: filter.branch_id,
    supplierId: filter.supplier_id,
    receiptId: filter.receipt_id,
  });
  return paginated(
    rows.map(({ doc, branch_name, supplier_name, receipt_number }) => ({
      id: doc.id,
      number: doc.number,
      branch_id: doc.branch_id,
      branch_name,
      supplier_id: doc.supplier_id,
      supplier_name,
      receipt_id: doc.receipt_id,
      receipt_number,
      note: doc.note,
      total_syp: Number(doc.total_syp),
      created_at: doc.created_at.toISOString(),
    })),
    total,
    params,
  );
}
