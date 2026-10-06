import { issueNumber } from '../../../core/numbering/numbering.js';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { resolveAvgCostAt } from '../../../core/costing/cost-port.js';
import { recordFinance, type FinanceEntry } from '../../../core/finance/finance-recorder.js';
import { issueStock } from '../../../core/stock/stock-port.js';
import {
  serviceLineHandler,
  type ServiceKind,
  type ServiceReturnDisposition,
} from '../../../core/till/service-line-port.js';
import { SALES_AUDIT, saleTarget } from '../audit-actions.js';
import * as repo from '../repositories/sales.repository.js';
import * as returnsRepo from '../repositories/returns.repository.js';
import type { SalesSettings } from '../repositories/returns.repository.js';
import type { SaleReturnRow } from '../schemas/returns.schema.js';
import { branchPrefix, roundSyp } from './sale-rules.js';
import {
  computeReturn,
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
  /** Print lines (`finance_ledger.md` §٣) — copies and money, both capped here. */
  service_lines: WireReturnableServiceLine[];
  /** Prints inside their own window (always true when prints have none). */
  prints_within_window: boolean;
  /** The policy the cashier works under — said before a line is picked. */
  policy: WireReturnPolicy;
}

/** What the till must know before it starts (`system_settings.md` §سياسة المرتجع). */
export interface WireReturnPolicy {
  goods_enabled: boolean;
  prints_enabled: boolean;
  beyond_window_action: 'approve' | 'refuse';
  print_window_days: number | null;
  refund_methods: ('cash' | 'customer_credit')[];
  approval_above_syp: number | null;
  reason_required: boolean;
  damaged_allowed: boolean;
  print_refund_suggest_percent: number;
}

export function policyOf(settings: SalesSettings): WireReturnPolicy {
  return {
    goods_enabled: settings.goods_returns_enabled,
    prints_enabled: settings.print_returns_enabled,
    beyond_window_action: settings.beyond_window_action,
    print_window_days: settings.print_return_window_days,
    refund_methods: [
      ...(settings.refund_cash_allowed ? (['cash'] as const) : []),
      ...(settings.refund_credit_allowed ? (['customer_credit'] as const) : []),
    ],
    approval_above_syp: settings.approval_above_syp,
    reason_required: settings.return_reason_required,
    damaged_allowed: settings.damaged_returns_allowed,
    print_refund_suggest_percent: settings.print_refund_suggest_percent,
  };
}

/** Prints have no window unless the policy sets one. */
function printsWithinWindow(paidAt: Date | null, settings: SalesSettings): boolean {
  const days = settings.print_return_window_days;
  if (days === null) return true;
  return paidAt !== null && withinWindow(paidAt, new Date(), days);
}

export interface WireReturnableServiceLine {
  sale_line_id: number;
  kind: ServiceKind;
  name_ar: string;
  /** The print's name — prefills the ready-shelf label. */
  label: string | null;
  sold_copies: number;
  returned_copies: number;
  returnable_copies: number;
  line_total_syp: number;
  refunded_syp: number;
  /** **What can still be paid back** — the cashier may give less, never more. */
  refundable_syp: number;
  /** Paid per copy — the suggested refund, not a rule. */
  unit_paid_syp: number;
  returnable: boolean;
  why_not: string | null;
}

type SaleLine = Awaited<ReturnType<typeof repo.findLines>>[number];

async function serviceLinesOf(
  lines: SaleLine[],
  exec?: Parameters<typeof returnsRepo.findReturnedQty>[1],
): Promise<WireReturnableServiceLine[]> {
  const service = lines.filter((l) => l.service_kind !== null && l.service_ref_id !== null);
  if (service.length === 0) return [];
  const ids = service.map((l) => l.id);
  const [returned, refunded] = await Promise.all([
    returnsRepo.findReturnedQty(ids, exec),
    returnsRepo.findRefundedSyp(ids, exec),
  ]);
  const out: WireReturnableServiceLine[] = [];
  for (const line of service) {
    const handler = serviceLineHandler(line.service_kind!);
    if (!handler.returnInfo) continue;
    const info = await handler.returnInfo(line.service_ref_id!);
    const total = num(line.line_total_syp);
    const back = returned.get(line.id) ?? 0;
    const paidBack = refunded.get(line.id) ?? 0;
    out.push({
      sale_line_id: line.id,
      kind: line.service_kind!,
      name_ar: line.name_ar,
      label: info.label,
      sold_copies: info.copies,
      returned_copies: back,
      returnable_copies: info.returnable ? Math.max(0, info.copies - back) : 0,
      line_total_syp: total,
      refunded_syp: paidBack,
      refundable_syp: roundSyp(Math.max(0, total - paidBack)),
      unit_paid_syp: info.copies > 0 ? roundSyp(total / info.copies) : 0,
      returnable: info.returnable,
      why_not: info.whyNot,
    });
  }
  return out;
}

/**
 * **الخدمات لا تُرجَع من هنا**: المرتجع يُعيد بضاعةً للرفّ ويَرُدّ ثمنها، وطلب
 * طباعةٍ مطبوع لا يعود لرفّ. ردُّ ثمن خدمة قرارٌ آخر (لم يُبنَ بعد).
 */
const goodsOnly = <T extends { variant_id: number | null }>(
  lines: T[],
): (T & { variant_id: number })[] =>
  lines.filter((l): l is T & { variant_id: number } => l.variant_id !== null);

async function soldLinesOf(saleId: number): Promise<SoldLine[]> {
  const lines = goodsOnly(await repo.findLines(saleId));
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
  const serviceLines = await serviceLinesOf(lines);

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
    service_lines: serviceLines,
    prints_within_window: printsWithinWindow(sale.paid_at, settings),
    policy: policyOf(settings),
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
  reason_code: string | null;
  created_at: string;
  lines: {
    sale_line_id: number;
    variant_id: number | null;
    service_kind: string | null;
    service_ref_id: number | null;
    /** Print lines only: ready · damaged · reprint. */
    disposition: string | null;
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
    reason_code: row.reason_code,
    created_at: row.created_at.toISOString(),
    lines: lines.map((l) => ({
      sale_line_id: l.sale_line_id,
      variant_id: l.variant_id,
      service_kind: l.service_kind,
      service_ref_id: l.service_ref_id,
      disposition: l.disposition,
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
  /** Why it came back — a code the reports group by (M-2). */
  reason_code?: string | null;
  /** من وافق على تجاوز المهلة — يصل بعد تحقّق المسار من كلمة مروره. */
  approver_user_id?: number | null;
  service_lines?: ServiceReturnLineInput[];
}

export interface ServiceReturnLineInput {
  saleLineId: number;
  copies: number;
  /** The cashier's amount — at most what is left to pay back, may be less. */
  refundSyp: number;
  disposition: ServiceReturnDisposition;
  label?: string | null;
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

  const serviceInput = input.service_lines ?? [];
  if (input.lines.length === 0 && serviceInput.length === 0) {
    throw new BusinessError(422, 'A return needs at least one line', 'return_empty');
  }
  const settings = await returnsRepo.findSettings();
  assertPolicyAllows(settings, input, serviceInput);
  // Goods and prints each have their own window — prints none by default
  // (user decision 2026-10-04).
  const goodsInWindow =
    input.lines.length === 0 ||
    (sale.paid_at !== null && withinWindow(sale.paid_at, new Date(), settings.return_window_days));
  const printsInWindow = serviceInput.length === 0 || printsWithinWindow(sale.paid_at, settings);
  const inWindow = goodsInWindow && printsInWindow;
  if (!inWindow && settings.beyond_window_action === 'refuse') {
    throw new BusinessError(409, 'This sale is past the return window', 'return_window_closed', {
      window_days: goodsInWindow ? settings.print_return_window_days : settings.return_window_days,
    });
  }
  const approver = input.approver_user_id ?? null;
  if (!inWindow && approver === null) {
    throw new BusinessError(
      409,
      'This sale is past the return window — a manager must approve',
      'return_window_passed',
      { window_days: goodsInWindow ? settings.print_return_window_days : settings.return_window_days },
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

  const created = await db.transaction(async (tx) => {
    // الأسطر مقفلة: بين حساب السقف وكتابة المرتجع لا يُرجع جهازٌ آخر القطعة نفسها.
    await returnsRepo.lockSaleLines(tx, input.sale_id);
    const allLines = await repo.findLines(input.sale_id, tx);
    const lines = goodsOnly(allLines);
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

    const outcome =
      input.lines.length === 0
        ? { ok: { lines: [], totalSyp: 0 } }
        : computeReturn(sold, input.lines);
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
          throw new BusinessError(
            422,
            'A returned quantity must be above zero',
            'return_qty_invalid',
          );
        case 'nothing_to_return':
          throw new BusinessError(422, 'A return needs at least one line', 'return_empty');
      }
    }

    const services = await checkServiceLines(allLines, serviceInput, tx);
    const serviceTotal = roundSyp(services.reduce((sum, s) => sum + s.input.refundSyp, 0));
    const totalSyp = roundSyp(outcome.ok.totalSyp + serviceTotal);
    const cap = settings.approval_above_syp;
    const overCap = cap !== null && totalSyp > cap;
    if (overCap && approver === null) {
      throw new BusinessError(409, 'A return this large needs a manager', 'return_needs_approval', {
        approval_above_syp: cap,
      });
    }

    const { number, sequence } = await issueNumber(tx, 'sale_return', branchPrefix(branch.code, input.branch_id));
    const nameById = new Map(lines.map((l) => [l.id, { name: l.name_ar, sku: l.sku }]));

    const row = await returnsRepo.insertReturn(tx, {
      branch_id: input.branch_id,
      sale_id: input.sale_id,
      number,
      sequence,
      customer_id: sale.customer_id,
      cashier_user_id: actor.userId,
      refund_method: input.refund_method,
      total_syp: String(totalSyp),
      beyond_window: !inWindow,
      approved_by: inWindow && !overCap ? null : approver,
      reason: input.reason?.trim() || null,
      reason_code: input.reason_code ?? null,
      policy: policyOf(settings),
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
    if (services.length > 0) {
      await returnsRepo.insertReturnLines(
        tx,
        services.map(({ line, input: s }) => ({
          return_id: row.id,
          sale_line_id: line.id,
          variant_id: null,
          name_ar: line.name_ar,
          sku: line.sku,
          qty: String(s.copies),
          unit_refund_syp: String(roundSyp(s.refundSyp / s.copies)),
          refund_syp: String(s.refundSyp),
          // «sellable» = back on a shelf (the ready shelf) — reprint and damaged are not.
          condition: s.disposition === 'ready' ? ('sellable' as const) : ('damaged' as const),
          qty_base: '0',
          service_kind: line.service_kind,
          service_ref_id: line.service_ref_id,
          disposition: s.disposition,
        })),
      );
    }

    // الرصيد: قيدٌ **موجب** — المتجر صار مديناً للزبون بقيمة ما أعاده.
    if (input.refund_method === 'customer_credit' && sale.customer_id !== null && totalSyp > 0) {
      await repo.insertLedgerEntries(tx, [
        {
          customer_id: sale.customer_id,
          amount_syp: String(totalSyp),
          reason: 'refund_to_credit',
          sale_id: input.sale_id,
          created_by_user_id: actor.userId,
        },
      ]);
    }

    // القيود (`finance_ledger.md` §٢): المردود بطريقته · عكس التكلفة **بتكلفة
    // لحظة البيع** (`unit_cost_syp` المجمَّدة؛ فواتير ما قبل السجل بمتوسط اليوم)
    // · والتالف خسارةٌ بالقيمة نفسها — لا يعود للرفّ، فعكسُ تكلفته وحده يُخفيه.
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const fallback = await resolveAvgCostAt(
      input.branch_id,
      outcome.ok.lines.map((l) => l.variantId),
    );
    const entries: FinanceEntry[] = [
      {
        branchId: input.branch_id,
        type: 'refund',
        method: input.refund_method,
        amountSyp: -totalSyp,
        docType: 'sale_return',
        docId: row.id,
        saleId: input.sale_id,
        userId: actor.userId,
        reason: input.reason_code ?? null,
        // Free text (up to 300) is a note; `reason` holds codes only (M-2).
        note: input.reason?.trim() || null,
      },
    ];
    for (const line of outcome.ok.lines) {
      const sold = lineById.get(line.saleLineId)!;
      const frozen = sold.unit_cost_syp === null ? null : num(sold.unit_cost_syp);
      const base = fallback.get(line.variantId);
      const unitCost = frozen ?? (base === null || base === undefined ? null : base * num(sold.unit_factor));
      if (unitCost === null) continue;
      const value = unitCost * line.qty;
      const common = {
        branchId: input.branch_id,
        method: 'value' as const,
        docType: 'sale_return' as const,
        docId: row.id,
        saleId: input.sale_id,
        userId: actor.userId,
        note: frozen === null ? 'cost_estimated_now' : null,
      };
      entries.push({ ...common, type: 'cogs_reversal', amountSyp: value });
      if (line.condition === 'damaged') {
        entries.push({
          ...common,
          type: 'loss_damaged_return',
          amountSyp: -value,
          note: input.reason?.trim() || common.note,
        });
      }
    }
    await recordFinance(tx, entries);

    // The copies: the print module decides where they go and records their value.
    for (const { line, input: s } of services) {
      await serviceLineHandler(line.service_kind!).processReturn!(tx, {
        refId: line.service_ref_id!,
        saleId: input.sale_id,
        returnId: row.id,
        branchId: input.branch_id,
        copies: s.copies,
        disposition: s.disposition,
        label: s.label?.trim() || null,
        reasonCode: input.reason_code ?? null,
        userId: actor.userId,
      });
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

/**
 * The policy's flat rules — before any line is read, so the refusal names the
 * rule rather than a line (`system_settings.md`).
 */
function assertPolicyAllows(
  settings: SalesSettings,
  input: CreateReturnInput,
  serviceInput: ServiceReturnLineInput[],
): void {
  if (input.lines.length > 0 && !settings.goods_returns_enabled) {
    throw new BusinessError(409, 'Goods returns are turned off', 'returns_goods_disabled');
  }
  if (serviceInput.length > 0 && !settings.print_returns_enabled) {
    throw new BusinessError(409, 'Print returns are turned off', 'returns_prints_disabled');
  }
  const methodAllowed =
    input.refund_method === 'cash' ? settings.refund_cash_allowed : settings.refund_credit_allowed;
  if (!methodAllowed) {
    throw new BusinessError(422, 'This refund method is not allowed', 'return_refund_method_not_allowed');
  }
  if (settings.return_reason_required && !input.reason_code && !input.reason?.trim()) {
    throw new BusinessError(422, 'A return needs a reason', 'return_reason_required');
  }
  if (!settings.damaged_returns_allowed && input.lines.some((l) => l.condition === 'damaged')) {
    throw new BusinessError(422, 'Damaged goods are not taken back', 'return_damaged_not_allowed');
  }
}

/**
 * Service lines checked **inside the locked transaction**: copies within what
 * is left, money within what is left, and a reprint pays nothing back.
 */
async function checkServiceLines(
  allLines: SaleLine[],
  requested: ServiceReturnLineInput[],
  tx: Parameters<typeof returnsRepo.findReturnedQty>[1],
): Promise<{ line: SaleLine; input: ServiceReturnLineInput }[]> {
  if (requested.length === 0) return [];
  const ids = new Set<number>();
  for (const r of requested) {
    if (ids.has(r.saleLineId)) {
      throw new BusinessError(422, 'A line appears twice', 'return_line_duplicate');
    }
    ids.add(r.saleLineId);
  }
  const caps = new Map((await serviceLinesOf(allLines, tx)).map((c) => [c.sale_line_id, c]));
  const byId = new Map(allLines.map((l) => [l.id, l]));
  return requested.map((r) => {
    const line = byId.get(r.saleLineId);
    const cap = caps.get(r.saleLineId);
    if (!line || !cap) {
      throw new BusinessError(422, 'That line is not on this sale', 'return_line_not_in_sale');
    }
    if (!cap.returnable) {
      throw new BusinessError(409, 'This line cannot be returned', 'return_not_returnable', {
        why_not: cap.why_not,
      });
    }
    if (!Number.isInteger(r.copies) || r.copies <= 0) {
      throw new BusinessError(422, 'A returned quantity must be above zero', 'return_qty_invalid');
    }
    if (r.copies > cap.returnable_copies) {
      throw new BusinessError(422, 'That is more than what is left to return', 'return_above_returnable', {
        sale_line_id: r.saleLineId,
        returnable_qty: cap.returnable_copies,
      });
    }
    if (r.disposition === 'reprint' && r.refundSyp > 0) {
      throw new BusinessError(422, 'A reprint pays nothing back', 'return_reprint_no_refund');
    }
    if (r.refundSyp < 0 || roundSyp(r.refundSyp) > cap.refundable_syp) {
      throw new BusinessError(422, 'That is more than what was paid', 'return_refund_above_paid', {
        sale_line_id: r.saleLineId,
        refundable_syp: cap.refundable_syp,
      });
    }
    return { line, input: { ...r, refundSyp: roundSyp(r.refundSyp) } };
  });
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
  const merged = { ...before, ...values };
  // A till that can refund no way at all would take a return and owe the money.
  if (!merged.refund_cash_allowed && !merged.refund_credit_allowed) {
    throw new BusinessError(422, 'Allow at least one refund method', 'settings_refund_method_required');
  }
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
