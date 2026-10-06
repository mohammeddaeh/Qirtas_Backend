import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { BusinessError } from '../../../core/http/api-error.js';
import {
  registerServiceLineHandler,
  type ServiceExec,
  type ServiceLineHandler,
  type ServiceLineQuote,
} from '../../../core/till/service-line-port.js';
import type { QuoteBody } from '../dtos/printing.dto.js';
import {
  printCounterSalesTable,
  type PrintCounterSaleRow,
} from '../schemas/print-counter-sales.schema.js';
import { printOptionsTable } from '../schemas/printing.schema.js';
import { consumeForCounterSale } from './consumption.service.js';
import { assertPrintableSpec, priceJob, type WireQuote } from './printing.service.js';
import { printReturnInfo, processPrintReturn } from './print-ready.js';

/**
 * بيع الطباعة المباشر بالصندوق — الشريحة 9-و (`printing_system.md` §خطة 9-و).
 *
 * **جاهزٌ فوراً لا طلب** (قرار المستخدم 2026-10-04): الكاشير يسعّر بالحاسبة،
 * يطبع، ويضيفه سطراً بالفاتورة. السعر من `priceJob` نفسه الذي يسعّر طلب الزبون،
 * **والمواد تُخصم بسداد الفاتورة وبمعاملتها** — بيعٌ دُفع بلا حركة لورقه يترك
 * الرفّ أعلى من الواقع، وخصمٌ قبل الدفع يُخصم لسلّةٍ قد تُلغى.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface WireCounterSale {
  id: number;
  branch_id: number;
  status: PrintCounterSaleRow['status'];
  pages: number;
  copies: number;
  total_syp: number;
  quote: WireQuote;
}

function toWire(row: PrintCounterSaleRow): WireCounterSale {
  return {
    id: row.id,
    branch_id: row.branch_id,
    status: row.status,
    pages: row.pages,
    copies: row.copies,
    total_syp: Number(row.total_syp),
    quote: row.quote as WireQuote,
  };
}

/** Prices the spec at the branch and keeps it `open` until a till takes it. */
export async function createCounterSale(
  userId: number,
  body: QuoteBody & { label?: string | null },
): Promise<WireCounterSale> {
  const spec = {
    paperSizeId: body.paper_size_id,
    colorModeId: body.color_mode_id,
    sidesId: body.sides_id,
    bindingId: body.binding_id,
    coverId: body.cover_id,
  };
  await assertPrintableSpec(body.branch_id, spec);
  const quote = await priceJob(body.branch_id, { ...spec, pages: body.pages, copies: body.copies });
  const [row] = await db
    .insert(printCounterSalesTable)
    .values({
      branch_id: body.branch_id,
      paper_size_id: body.paper_size_id,
      color_mode_id: body.color_mode_id,
      sides_id: body.sides_id,
      binding_id: body.binding_id,
      cover_id: body.cover_id,
      label: body.label?.trim() || null,
      pages: body.pages,
      copies: body.copies,
      quote,
      total_syp: quote.total_syp.toFixed(2),
      created_by: userId,
    })
    .returning();
  return toWire(row!);
}

/**
 * «طباعة A4 · ملوّن · وجهان · ١٠ ص × ٢» — what the receipt says. The
 * «none» finishings are left out: «بلا تجليد» on a receipt is noise.
 */
async function lineName(row: PrintCounterSaleRow): Promise<string> {
  const ids = [row.paper_size_id, row.color_mode_id, row.sides_id, row.binding_id, row.cover_id];
  const options = await db
    .select({ id: printOptionsTable.id, code: printOptionsTable.code, name: printOptionsTable.name_ar })
    .from(printOptionsTable)
    .where(inArray(printOptionsTable.id, ids));
  const byId = new Map(options.map((o) => [o.id, o]));
  const spec = ids
    .map((id) => byId.get(id))
    .filter((o): o is NonNullable<typeof o> => o !== undefined && o.code !== 'none')
    .map((o) => o.name)
    .join(' · ');
  // الاسم أولاً حين يوجد — به يقرأ الكاشير الفاتورة وبه يُطابَق رفّ الجاهز.
  const tail = `${row.pages} ص × ${row.copies}`;
  return row.label ? `${row.label} — طباعة ${spec} · ${tail}` : `طباعة ${spec} · ${tail}`;
}

async function resolve(input: {
  reference: string;
  branchId: number;
  saleId: number;
}): Promise<ServiceLineQuote> {
  const id = Number(input.reference.trim());
  const [row] = Number.isInteger(id)
    ? await db.select().from(printCounterSalesTable).where(eq(printCounterSalesTable.id, id)).limit(1)
    : [];
  if (!row || row.status !== 'open') {
    throw new BusinessError(404, 'No open print sale with this reference', 'print_counter_not_found', {
      reference: input.reference,
    });
  }
  if (row.branch_id !== input.branchId) {
    throw new BusinessError(409, 'This print sale belongs to another branch', 'print_counter_other_branch', {
      branch_id: row.branch_id,
    });
  }
  if (row.sale_id !== null && row.sale_id !== input.saleId) {
    throw new BusinessError(409, 'This print sale is already at another till', 'print_counter_in_other_sale', {
      sale_id: row.sale_id,
    });
  }
  return {
    refId: row.id,
    nameAr: await lineName(row),
    sku: `PC-${row.id}`,
    amountSyp: Number(row.total_syp),
    taxPercent: 0,
    customerId: null,
  };
}

async function attach(exec: ServiceExec, refId: number, saleId: number): Promise<void> {
  await exec
    .update(printCounterSalesTable)
    .set({ sale_id: saleId })
    .where(eq(printCounterSalesTable.id, refId));
}

/** Removed or voided with its basket: it never lived outside that basket. */
async function detach(exec: ServiceExec, refId: number): Promise<void> {
  await exec
    .update(printCounterSalesTable)
    .set({ status: 'void' })
    .where(eq(printCounterSalesTable.id, refId));
}

/** Paid: settled, and the paper, ink and binding leave the shelf — same transaction. */
async function settle(exec: ServiceExec, refId: number, saleId: number, userId: number): Promise<void> {
  const tx = exec as Tx;
  const [row] = await tx
    .select()
    .from(printCounterSalesTable)
    .where(eq(printCounterSalesTable.id, refId))
    .for('update')
    .limit(1);
  if (!row || row.status !== 'open' || row.sale_id !== saleId) {
    throw new BusinessError(409, 'This print sale cannot be paid now', 'print_counter_not_payable', {
      status: row?.status ?? null,
    });
  }
  const quote = row.quote as WireQuote;
  const cost = await consumeForCounterSale(
    tx,
    {
      id: row.id,
      branchId: row.branch_id,
      saleId,
      optionIds: [row.paper_size_id, row.color_mode_id, row.sides_id, row.binding_id, row.cover_id],
      sheets: quote.sheets,
      printedPages: quote.printed_pages,
      copies: quote.copies,
    },
    userId,
  );
  await tx
    .update(printCounterSalesTable)
    .set({ status: 'settled', settled_at: new Date(), materials_cost_syp: cost.toFixed(2) })
    .where(eq(printCounterSalesTable.id, refId));
}

const handler: ServiceLineHandler = {
  kind: 'print_counter',
  resolve,
  attach,
  detach,
  settle,
  returnInfo: (refId) => printReturnInfo('print_counter', refId),
  processReturn: (exec, input) => processPrintReturn(exec, 'print_counter', input),
};

/** يُستدعى من `buildApp()` بجانب `installPrintServiceLine`. */
export function installPrintCounterServiceLine(): void {
  registerServiceLineHandler(handler);
}
