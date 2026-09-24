import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { issueStock } from '../../../core/stock/stock-port.js';
import { SALES_AUDIT, saleTarget } from '../audit-actions.js';
import * as repo from '../repositories/sales.repository.js';
import * as returnsRepo from '../repositories/returns.repository.js';
import type { SalesSettings } from '../repositories/returns.repository.js';
import type { SaleReturnRow } from '../schemas/returns.schema.js';
import { branchPrefix, roundSyp } from './sale-rules.js';
import {
  computeReturn,
  formatReturnNumber,
  paidUnitPrice,
  returnableQty,
  withinWindow,
  type ReturnLineInput,
  type SoldLine,
} from './return-rules.js';

const num = (v: string | null): number => (v === null ? 0 : Number(v));

// ── ما يصلح للإرجاع ─────────────────────────────────────────────────────────

export interface WireReturnableLine {
  sale_line_id: number;
  variant_id: number;
  name_ar: string;
  sku: string;
  sold_qty: number;
  returned_qty: number;
  /** **ما بقي** — يحسبه الخادم، ولا يُطرح بالعميل. */
  returnable_qty: number;
  /** السعر المدفوع فعلاً للوحدة — بعد العرض وبعد حصّة خصم الكاشير. */
  unit_refund_syp: number;
}

export interface WireReturnable {
  sale_id: number;
  number: string | null;
  paid_at: string | null;
  customer_id: number | null;
  /** داخل المهلة الآن — وخارجها يحتاج موافقة مدير لا رفضاً قاطعاً. */
  within_window: boolean;
  window_days: number;
  lines: WireReturnableLine[];
}

async function soldLinesOf(saleId: number): Promise<SoldLine[]> {
  const lines = await repo.findLines(saleId);
  const returned = await returnsRepo.findReturnedQty(lines.map((l) => l.id));
  return lines.map((line) => ({
    saleLineId: line.id,
    variantId: line.variant_id,
    qty: num(line.qty),
    lineTotalSyp: num(line.line_total_syp),
    unitFactor: num(line.unit_factor),
    returnedQty: returned.get(line.id) ?? 0,
  }));
}

/**
 * ما يصلح للإرجاع من فاتورة — **والسقف والسعر كلاهما من الخادم**.
 *
 * طرحُ المُرجَع بالعميل يجعل جهازين يرجعان القطعة نفسها معاً، وحسابُ السعر
 * هناك يتجاهل حصّة السطر من خصم الكاشير فيُخرج من الدرج أكثر مما دخله.
 */
export async function getReturnable(saleId: number): Promise<WireReturnable> {
  const sale = await repo.findSaleById(saleId);
  if (!sale) throw new NotFoundError('Sale not found');
  if (sale.status !== 'paid') {
    // سلّةٌ لم تُسدَّد لا يُرَدّ عنها مال: لم يدخل الدرج شيء.
    throw new BusinessError(409, 'Only a paid sale can be returned', 'return_sale_not_paid');
  }
  const [sold, settings, lines] = await Promise.all([
    soldLinesOf(saleId),
    returnsRepo.findSettings(),
    repo.findLines(saleId),
  ]);
  const nameById = new Map(lines.map((l) => [l.id, { name: l.name_ar, sku: l.sku }]));

  return {
    sale_id: sale.id,
    number: sale.number,
    paid_at: sale.paid_at?.toISOString() ?? null,
    customer_id: sale.customer_id,
    within_window:
      sale.paid_at === null
        ? false
        : withinWindow(sale.paid_at, new Date(), settings.return_window_days),
    window_days: settings.return_window_days,
    lines: sold.map((line) => ({
      sale_line_id: line.saleLineId,
      variant_id: line.variantId,
      name_ar: nameById.get(line.saleLineId)?.name ?? '',
      sku: nameById.get(line.saleLineId)?.sku ?? '',
      sold_qty: line.qty,
      returned_qty: line.returnedQty,
      returnable_qty: returnableQty(line),
      unit_refund_syp: roundSyp(paidUnitPrice(line)),
    })),
  };
}

// ── الإنشاء ─────────────────────────────────────────────────────────────────

export interface WireReturn {
  id: number;
  number: string;
  branch_id: number;
  sale_id: number;
  customer_id: number | null;
  refund_method: SaleReturnRow['refund_method'];
  total_syp: number;
  beyond_window: boolean;
  approved_by: number | null;
  reason: string | null;
  created_at: string;
  lines: {
    sale_line_id: number;
    variant_id: number;
    name_ar: string;
    sku: string;
    qty: number;
    unit_refund_syp: number;
    refund_syp: number;
    condition: 'sellable' | 'damaged';
  }[];
}

export async function getReturn(id: number): Promise<WireReturn> {
  const row = await returnsRepo.findReturnById(id);
  if (!row) throw new NotFoundError('Return not found');
  const lines = await returnsRepo.findReturnLines(id);
  return {
    id: row.id,
    number: row.number,
    branch_id: row.branch_id,
    sale_id: row.sale_id,
    customer_id: row.customer_id,
    refund_method: row.refund_method,
    total_syp: num(row.total_syp),
    beyond_window: row.beyond_window,
    approved_by: row.approved_by,
    reason: row.reason,
    created_at: row.created_at.toISOString(),
    lines: lines.map((l) => ({
      sale_line_id: l.sale_line_id,
      variant_id: l.variant_id,
      name_ar: l.name_ar,
      sku: l.sku,
      qty: num(l.qty),
      unit_refund_syp: num(l.unit_refund_syp),
      refund_syp: num(l.refund_syp),
      condition: l.condition,
    })),
  };
}

export interface CreateReturnInput {
  branch_id: number;
  sale_id: number;
  lines: ReturnLineInput[];
  refund_method: 'cash' | 'customer_credit';
  reason?: string | null;
  /** من وافق على تجاوز المهلة — يصل بعد تحقّق المسار من كلمة مروره. */
  approver_user_id?: number | null;
}

/**
 * يسجّل المرتجع: يصرف رقمه · يردّ المال · يُعيد الصالح للرفّ.
 *
 * **الثلاثة بمعاملة واحدة** — فصلُها يترك مرتجعاً بلا بضاعة عادت، أو بضاعةً
 * دخلت الرفّ بلا ما يقول لماذا.
 *
 * **والبضاعة تدخل مخزون الفرع المستلِم** (§٢) لا البائع: الإرجاع بأي فرع،
 * والرصيد يزيد حيث القطعة فعلاً — وإلا صار بالدفتر قلمٌ بفرعٍ لا وجود له فيه.
 */
export async function createReturn(
  actor: RequestActorContext,
  input: CreateReturnInput,
): Promise<WireReturn> {
  const sale = await repo.findSaleById(input.sale_id);
  if (!sale) throw new NotFoundError('Sale not found');
  if (sale.status !== 'paid') {
    throw new BusinessError(409, 'Only a paid sale can be returned', 'return_sale_not_paid');
  }

  const settings = await returnsRepo.findSettings();
  const inWindow =
    sale.paid_at !== null && withinWindow(sale.paid_at, new Date(), settings.return_window_days);
  if (!inWindow && (input.approver_user_id ?? null) === null) {
    throw new BusinessError(
      409,
      'This sale is past the return window — a manager must approve',
      'return_window_passed',
      { window_days: settings.return_window_days },
    );
  }

  // **الرصيد للمسمّى وحده** (قرار 2026-09-24): رصيدٌ لمن لا حساب له مالٌ لا
  // يعود إليه أبداً، والعابر يأخذ نقده ويمضي.
  if (input.refund_method === 'customer_credit' && sale.customer_id === null) {
    throw new BusinessError(
      422,
      'Store credit needs a named customer',
      'return_credit_needs_customer',
    );
  }

  const branch = await repo.findBranch(input.branch_id);
  if (!branch) throw new NotFoundError('Branch not found');
  const year = new Date().getFullYear();

  const created = await db.transaction(async (tx) => {
    // الأسطر مقفلة: بين حساب السقف وكتابة المرتجع لا يُرجع جهازٌ آخر القطعة نفسها.
    await returnsRepo.lockSaleLines(tx, input.sale_id);
    const lines = await repo.findLines(input.sale_id, tx);
    const returned = await returnsRepo.findReturnedQty(
      lines.map((l) => l.id),
      tx,
    );
    const sold: SoldLine[] = lines.map((line) => ({
      saleLineId: line.id,
      variantId: line.variant_id,
      qty: num(line.qty),
      lineTotalSyp: num(line.line_total_syp),
      unitFactor: num(line.unit_factor),
      returnedQty: returned.get(line.id) ?? 0,
    }));

    const outcome = computeReturn(sold, input.lines);
    if ('problem' in outcome) {
      const problem = outcome.problem;
      switch (problem.kind) {
        case 'above_returnable':
          throw new BusinessError(
            422,
            'That is more than what is left to return',
            'return_above_returnable',
            { sale_line_id: problem.saleLineId, returnable_qty: problem.returnable },
          );
        case 'line_not_in_sale':
          throw new BusinessError(422, 'That line is not on this sale', 'return_line_not_in_sale');
        case 'qty_not_positive':
          throw new BusinessError(422, 'A returned quantity must be above zero', 'return_qty_invalid');
        case 'nothing_to_return':
          throw new BusinessError(422, 'A return needs at least one line', 'return_empty');
      }
    }

    const sequence = await returnsRepo.nextReturnSequence(tx, input.branch_id, year);
    const number = formatReturnNumber(
      branchPrefix(branch.name, input.branch_id),
      year,
      sequence,
    );
    const nameById = new Map(lines.map((l) => [l.id, { name: l.name_ar, sku: l.sku }]));

    const row = await returnsRepo.insertReturn(tx, {
      branch_id: input.branch_id,
      sale_id: input.sale_id,
      number,
      sequence,
      customer_id: sale.customer_id,
      cashier_user_id: actor.userId,
      refund_method: input.refund_method,
      total_syp: String(outcome.ok.totalSyp),
      beyond_window: !inWindow,
      approved_by: inWindow ? null : (input.approver_user_id ?? null),
      reason: input.reason?.trim() || null,
    });

    await returnsRepo.insertReturnLines(
      tx,
      outcome.ok.lines.map((line) => ({
        return_id: row.id,
        sale_line_id: line.saleLineId,
        variant_id: line.variantId,
        name_ar: nameById.get(line.saleLineId)?.name ?? '',
        sku: nameById.get(line.saleLineId)?.sku ?? '',
        qty: String(line.qty),
        unit_refund_syp: String(line.unitRefundSyp),
        refund_syp: String(line.refundSyp),
        condition: line.condition,
        qty_base: String(line.qtyBase),
      })),
    );

    // الرصيد: قيدٌ **موجب** — المتجر صار مديناً للزبون بقيمة ما أعاده.
    if (input.refund_method === 'customer_credit' && sale.customer_id !== null) {
      await repo.insertLedgerEntries(tx, [
        {
          customer_id: sale.customer_id,
          amount_syp: String(outcome.ok.totalSyp),
          reason: 'refund_to_credit',
          sale_id: input.sale_id,
          created_by_user_id: actor.userId,
        },
      ]);
    }

    // **الصالح وحده يعود للرفّ**؛ التالف `qty_base = 0` فلا حركة له.
    const returning = outcome.ok.lines.filter((line) => line.qtyBase > 0);
    await issueStock({
      exec: tx,
      branchId: input.branch_id,
      lines: returning.map((line) => ({ variantId: line.variantId, qtyBase: line.qtyBase })),
      docType: 'return',
      docId: row.id,
      userId: actor.userId,
    });

    return row;
  });

  await recordAudit(actor, SALES_AUDIT.refund, saleTarget.return_(created.id), null, {
    number: created.number,
    sale_id: input.sale_id,
    total_syp: num(created.total_syp),
    beyond_window: created.beyond_window,
  });
  return getReturn(created.id);
}

// ── الإعدادات ───────────────────────────────────────────────────────────────

export async function getSettings(): Promise<SalesSettings> {
  return returnsRepo.findSettings();
}

/**
 * إعدادات البيع — **والحقل الذي لم يُرسل لا يُلمس**.
 *
 * مهلة الإرجاع ومهلة حجز الطلب صفٌّ واحد، وشاشتان تكتبانه. كتابةُ كل الحقول من
 * جسمٍ ناقص تجعل كل تعديل لواحدة يدهس الأخرى بصمت.
 */
export async function setSettings(
  actor: RequestActorContext,
  values: Partial<SalesSettings>,
): Promise<SalesSettings> {
  const before = await returnsRepo.findSettings();
  await returnsRepo.saveSettings(values, actor.userId);
  const after = await returnsRepo.findSettings();
  await recordAudit(actor, SALES_AUDIT.settings, saleTarget.settings(), before, after);
  return after;
}

export async function listReturns(
  filters: { branchId?: number; saleId?: number },
  limit: number,
  offset: number,
): Promise<{ items: WireReturn[]; total: number }> {
  const { rows, total } = await returnsRepo.findReturns(filters, limit, offset);
  const items = await Promise.all(rows.map((row) => getReturn(row.id)));
  return { items, total };
}
