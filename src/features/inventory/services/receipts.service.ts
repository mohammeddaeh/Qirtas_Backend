import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { paginated, type Paginated, type PaginationParams } from '../../../core/pagination/pagination.js';
import { INVENTORY_AUDIT, inventoryTarget } from '../audit-actions.js';
import type { ReceiptBody, WireReceipt, WireReceiptLine } from '../dtos/stock.dto.js';
import * as receiptsRepository from '../repositories/receipts.repository.js';
import * as stockRepository from '../repositories/stock.repository.js';
import * as suppliersRepository from '../repositories/suppliers.repository.js';
import { lineUnitCost, type CostPair } from './stock-rules.js';
import { nextNumber, postMovements } from './stock.service.js';

/**
 * Receiving goods — a purchase invoice that posts its movements the moment it
 * is saved (inventory_suppliers.md §٧–§٨).
 *
 * The invoice is priced in *its* units (a carton at 60,000) and stock counts
 * base units (144 pieces at 500 each). Both are stored: the first is what the
 * reader checks against the paper, the second is what every report adds up.
 */

interface PreparedLine {
  variant_id: number;
  unit_id: number;
  qty: number;
  factor: number;
  qty_base: number;
  unit_cost: number;
  cost: CostPair;
  expires_at: Date | null;
}

/**
 * Turns the typed lines into base units and costs, refusing anything the
 * ledger could not represent honestly: an unknown variant, a unit that is not
 * one of that variant's, or a dollar invoice with no rate — whose dollar cost
 * would otherwise be guessed and then followed for the life of the stock.
 */
async function prepareLines(body: ReceiptBody): Promise<PreparedLine[]> {
  const variantIds = [...new Set(body.lines.map((line) => line.variant_id))];
  const [units, variants] = await Promise.all([
    stockRepository.findVariantUnits(variantIds),
    stockRepository.findLiveVariants(variantIds),
  ]);
  for (const id of variantIds) {
    const variant = variants.find((v) => v.variant_id === id);
    if (!variant) throw new BusinessError(422, 'Unknown variant on a line', 'receipt_variant_unknown', { variant_id: id });
    if (variant.archived_at !== null)
      throw new BusinessError(409, 'That product is archived', 'receipt_product_archived', { variant_id: id });
  }
  const rate = body.exchange_rate ?? null;
  if (body.currency === 'USD' && (rate === null || rate <= 0))
    throw new BusinessError(422, 'A dollar invoice needs its exchange rate', 'receipt_rate_required');

  return body.lines.map((line) => {
    const unit = units.find((u) => u.variant_id === line.variant_id && u.unit_id === line.unit_id);
    if (!unit)
      throw new BusinessError(422, 'That unit does not belong to this variant', 'receipt_unit_mismatch', {
        variant_id: line.variant_id,
        unit_id: line.unit_id,
      });
    const factor = Number(unit.factor);
    const cost = lineUnitCost(line.unit_cost, factor, body.currency, rate);
    if (!cost) throw new BusinessError(422, 'The line cost could not be computed', 'receipt_cost_invalid');
    return {
      variant_id: line.variant_id,
      unit_id: line.unit_id,
      qty: line.qty,
      factor,
      qty_base: Number((line.qty * factor).toFixed(3)),
      unit_cost: line.unit_cost,
      cost,
      expires_at: line.expires_at ? new Date(line.expires_at) : null,
    };
  });
}

export async function createReceipt(actor: RequestActorContext, body: ReceiptBody): Promise<WireReceipt> {
  const supplier = await suppliersRepository.findById(body.supplier_id);
  if (!supplier) throw new NotFoundError('Supplier not found');
  if (supplier.archived_at !== null)
    throw new BusinessError(409, 'This supplier is archived', 'supplier_archived');

  const lines = await prepareLines(body);
  const totalSyp = Number(lines.reduce((sum, line) => sum + line.qty_base * line.cost.syp, 0).toFixed(2));
  const totalUsd = Number(lines.reduce((sum, line) => sum + line.qty_base * line.cost.usd, 0).toFixed(4));

  const invoiceId = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, body.branch_id, 'receipt', 'GRN');
    const invoice = await receiptsRepository.insertInvoice(
      tx,
      {
        branch_id: body.branch_id,
        supplier_id: body.supplier_id,
        number,
        supplier_invoice_no: body.supplier_invoice_no ?? null,
        invoice_date: new Date(body.invoice_date),
        currency: body.currency,
        exchange_rate: body.exchange_rate ?? null,
        total_syp: totalSyp,
        total_usd: totalUsd,
        note: body.note ?? null,
      },
      actor.userId,
    );
    await receiptsRepository.insertLines(
      tx,
      invoice.id,
      lines.map((line) => ({
        variant_id: line.variant_id,
        unit_id: line.unit_id,
        qty: line.qty,
        factor: line.factor,
        qty_base: line.qty_base,
        unit_cost: line.unit_cost,
        unit_cost_base_syp: line.cost.syp,
        unit_cost_base_usd: line.cost.usd,
        expires_at: line.expires_at,
      })),
    );
    await postMovements(tx, {
      branchId: body.branch_id,
      type: 'receipt',
      docType: 'receipt',
      docId: invoice.id,
      userId: actor.userId,
      lines: lines.map((line) => ({ variantId: line.variant_id, qtyBase: line.qty_base, cost: line.cost })),
    });
    // The layers are what an expiry warning and a future FIFO report read;
    // an average cannot be taken apart again into the receipts that made it.
    await stockRepository.insertLayers(
      tx,
      lines.map((line) => ({
        branch_id: body.branch_id,
        variant_id: line.variant_id,
        receipt_id: invoice.id,
        qty_base: line.qty_base,
        unit_cost_syp: line.cost.syp,
        unit_cost_usd: line.cost.usd,
        expires_at: line.expires_at,
      })),
    );
    return invoice.id;
  });

  await recordAudit(actor, INVENTORY_AUDIT.receiptPost, inventoryTarget.receipt(invoiceId), null, {
    branch_id: body.branch_id,
    supplier_id: body.supplier_id,
    lines: lines.length,
    total_syp: totalSyp,
  });
  return getReceipt(invoiceId);
}

function toWireLine(row: Awaited<ReturnType<typeof receiptsRepository.findLines>>[number]): WireReceiptLine {
  return {
    variant_id: row.variant_id,
    sku: row.sku,
    product_name_ar: row.product_name_ar,
    unit_id: row.unit_id,
    unit_name_ar: row.unit_name_ar,
    qty: Number(row.qty),
    factor: Number(row.factor),
    qty_base: Number(row.qty_base),
    unit_cost: Number(row.unit_cost),
    unit_cost_base_syp: Number(row.unit_cost_base_syp),
    expires_at: row.expires_at?.toISOString() ?? null,
  };
}

export async function getReceipt(id: number): Promise<WireReceipt> {
  const found = await receiptsRepository.findById(id);
  if (!found) throw new NotFoundError('Receipt not found');
  const lines = await receiptsRepository.findLines(id);
  const { invoice } = found;
  return {
    id: invoice.id,
    branch_id: invoice.branch_id,
    branch_name: found.branch_name,
    supplier_id: invoice.supplier_id,
    supplier_name: found.supplier_name,
    number: invoice.number,
    supplier_invoice_no: invoice.supplier_invoice_no,
    invoice_date: invoice.invoice_date.toISOString(),
    currency: invoice.currency,
    exchange_rate: invoice.exchange_rate === null ? null : Number(invoice.exchange_rate),
    total_syp: Number(invoice.total_syp),
    total_usd: Number(invoice.total_usd),
    note: invoice.note,
    created_at: invoice.created_at.toISOString(),
    created_by: found.first_name ? `${found.first_name} ${found.last_name ?? ''}`.trim() : null,
    lines: lines.map(toWireLine),
  };
}

export async function listReceipts(
  params: PaginationParams,
  filter: { branch_id?: number; supplier_id?: number },
): Promise<Paginated<Omit<WireReceipt, 'lines' | 'created_by'>>> {
  const { rows, total } = await receiptsRepository.findMany(params, {
    branchId: filter.branch_id,
    supplierId: filter.supplier_id,
  });
  const wire = rows.map(({ invoice, supplier_name, branch_name }) => ({
    id: invoice.id,
    branch_id: invoice.branch_id,
    branch_name,
    supplier_id: invoice.supplier_id,
    supplier_name,
    number: invoice.number,
    supplier_invoice_no: invoice.supplier_invoice_no,
    invoice_date: invoice.invoice_date.toISOString(),
    currency: invoice.currency,
    exchange_rate: invoice.exchange_rate === null ? null : Number(invoice.exchange_rate),
    total_syp: Number(invoice.total_syp),
    total_usd: Number(invoice.total_usd),
    note: invoice.note,
    created_at: invoice.created_at.toISOString(),
  }));
  return paginated(wire, total, params);
}
