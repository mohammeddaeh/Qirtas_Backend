import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { resolvePricesAt } from '../../../core/pricing/price-port.js';
import { issueStock } from '../../../core/stock/stock-port.js';
import { SALES_AUDIT, saleTarget } from '../audit-actions.js';
import * as repo from '../repositories/sales.repository.js';
import { closePaidOrder, reopenVoidedOrder } from './orders.service.js';
import type { SaleLineRow, SaleRow } from '../schemas/sales.schema.js';
import {
  branchPrefix,
  computeTotals,
  creditAvailable,
  formatSaleNumber,
  judgeDiscount,
  roundSyp,
  settle,
  spendableCredit,
  type PaymentInput,
  type SaleLineInput,
} from './sale-rules.js';

const num = (v: string | null): number => (v === null ? 0 : Number(v));

/**
 * ما يُسأل عنه منفذ السعر من نقطة البيع: **القناة `pos` دائماً**، والعروض
 * تُطبَّق.
 *
 * القناة ليست خياراً يُمرَّر: عرضُ الإنترنت الذي يُطبَّق بالكاشير يُخسِّر
 * مرتين، وقيمةٌ يرسلها الجهاز تجعل الكاشير يختار أي العروض تسري.
 */
const POS_PRICES = { promotions: 'apply', channel: 'pos', segment: 'retail' } as const;

// ── القراءة ─────────────────────────────────────────────────────────────────

export interface WireSaleLine {
  id: number;
  variant_id: number;
  product_id: number;
  name_ar: string;
  sku: string;
  unit_id: number | null;
  unit_name_ar: string | null;
  unit_factor: number;
  qty: number;
  unit_price_syp: number;
  promotion_discount_syp: number;
  promotion_names: string[];
  manual_discount_syp: number;
  tax_percent: number;
  tax_syp: number;
  line_total_syp: number;
}

export interface WireSale {
  id: number;
  branch_id: number;
  status: SaleRow['status'];
  number: string | null;
  customer_id: number | null;
  customer_name: string | null;
  cashier_user_id: number;
  discount_percent: number;
  discount_reason: string | null;
  discount_approved_by: number | null;
  subtotal_syp: number;
  discount_syp: number;
  tax_syp: number;
  total_syp: number;
  lines: WireSaleLine[];
  payments: { method: string; amount_syp: number; tendered_syp: number | null }[];
  created_at: string;
  paid_at: string | null;
}

function wireLine(row: SaleLineRow): WireSaleLine {
  return {
    id: row.id,
    variant_id: row.variant_id,
    product_id: row.product_id,
    name_ar: row.name_ar,
    sku: row.sku,
    unit_id: row.unit_id,
    unit_name_ar: row.unit_name_ar,
    unit_factor: num(row.unit_factor),
    qty: num(row.qty),
    unit_price_syp: num(row.unit_price_syp),
    promotion_discount_syp: num(row.promotion_discount_syp),
    promotion_names: row.promotion_names === null ? [] : row.promotion_names.split(' · '),
    manual_discount_syp: num(row.manual_discount_syp),
    tax_percent: num(row.tax_percent),
    tax_syp: num(row.tax_syp),
    line_total_syp: num(row.line_total_syp),
  };
}

/**
 * السلّة كما تُعرض — **ومجاميعها تُحسب حيّاً ما دامت مفتوحة**.
 *
 * المدفوعة تقرأ المجمَّد بالصفّ: إعادة حسابها بعد شهر تقرأ عرضاً انتهى وسعراً
 * تغيّر، فتقول فاتورةٌ طُبعت رقماً آخر. والمفتوحة عكسه تماماً — حسابُها من
 * عمودٍ محفوظ يعرض مجموعاً لا يتبع السطر الذي أُضيف للتوّ.
 */
export async function getSale(id: number): Promise<WireSale> {
  const sale = await repo.findSaleById(id);
  if (!sale) throw new NotFoundError('Sale not found');
  const [lines, payments] = await Promise.all([repo.findLines(id), repo.findPayments(id)]);

  const totals =
    sale.status === 'paid'
      ? {
          subtotalSyp: num(sale.subtotal_syp),
          discountSyp: num(sale.discount_syp),
          taxSyp: num(sale.tax_syp),
          totalSyp: num(sale.total_syp),
        }
      : computeTotals(lines.map(toRuleLine), num(sale.discount_percent));

  const computed = sale.status === 'paid' ? null : computeTotals(lines.map(toRuleLine), num(sale.discount_percent));
  return {
    id: sale.id,
    branch_id: sale.branch_id,
    status: sale.status,
    number: sale.number,
    customer_id: sale.customer_id,
    customer_name: sale.customer_name,
    cashier_user_id: sale.cashier_user_id,
    discount_percent: num(sale.discount_percent),
    discount_reason: sale.discount_reason,
    discount_approved_by: sale.discount_approved_by,
    subtotal_syp: roundSyp(totals.subtotalSyp),
    discount_syp: roundSyp(totals.discountSyp),
    tax_syp: roundSyp(totals.taxSyp),
    total_syp: roundSyp(totals.totalSyp),
    lines: lines.map((row, i) => {
      const wire = wireLine(row);
      // المفتوحة تعرض حصّة الخصم كما تُحسب الآن، لا كما كانت قبل السطر الأخير.
      if (computed === null) return wire;
      const share = computed.lines[i];
      return share === undefined
        ? wire
        : {
            ...wire,
            manual_discount_syp: share.manualDiscountSyp,
            tax_syp: share.taxSyp,
            line_total_syp: share.lineTotalSyp,
          };
    }),
    payments: payments.map((p) => ({
      method: p.method,
      amount_syp: num(p.amount_syp),
      tendered_syp: p.tendered_syp === null ? null : num(p.tendered_syp),
    })),
    created_at: sale.created_at.toISOString(),
    paid_at: sale.paid_at?.toISOString() ?? null,
  };
}

function toRuleLine(row: SaleLineRow): SaleLineInput {
  return {
    variantId: row.variant_id,
    qty: num(row.qty),
    unitPriceSyp: num(row.unit_price_syp),
    promotionDiscountSyp: num(row.promotion_discount_syp),
    taxPercent: num(row.tax_percent),
  };
}

export async function listOpenSales(branchId: number, cashierId: number): Promise<WireSale[]> {
  const rows = await repo.findOpenSales(branchId, cashierId);
  return Promise.all(rows.map((row) => getSale(row.id)));
}

export interface WireSellableItem {
  variant_id: number;
  product_id: number;
  sku: string;
  name_ar: string;
  on_hand: number;
  price_syp: number | null;
  was_syp: number | null;
  promotion_names: string[];
  /** مسحةٌ طابقت رمزاً تماماً — بها يُضاف الصنف بلا اختيار. */
  exact_barcode: boolean;
}

/**
 * ما يصلح لسطر بيع، بسعره **بالفرع** ورصيده.
 *
 * السعر يسافر مع الصف لأن الكاشير يقرأه للزبون قبل أن يضيفه؛ وجلبُه بنداء
 * ثانٍ لكل صف يجعل قائمةً من خمسةٍ خمسةَ نداءات.
 *
 * **والمسحة التي طابقت رمزاً تماماً تُعلَّم**: صفٌّ واحد بعلامة يُضاف مباشرةً،
 * وقائمةٌ بلا تمييز تجعل الكاشير يقرأ خمسة أسماء ليجد ما بيده.
 */
export async function searchItems(
  branchId: number,
  search: string,
): Promise<WireSellableItem[]> {
  const rows = await repo.searchSellableItems(search.trim(), branchId, 25);
  if (rows.length === 0) return [];
  const prices = await resolvePricesAt(branchId, rows.map((r) => r.variant_id), POS_PRICES);
  return rows.map((row) => {
    const price = prices.get(row.variant_id);
    const priced = price?.status === 'priced' ? price : null;
    return {
      variant_id: row.variant_id,
      product_id: row.product_id,
      sku: row.sku,
      name_ar: row.product_name_ar,
      on_hand: Number(row.on_hand ?? 0),
      // «غير مسعَّر» يصل `null` لا صفراً: صفرٌ يُقرأ مجاناً، ويضيفه الكاشير.
      price_syp: priced?.amountSyp ?? null,
      was_syp: priced?.promotion?.beforeSyp ?? null,
      promotion_names: priced?.promotion?.names ?? [],
      exact_barcode: row.exact_barcode === true,
    };
  });
}

// ── الكتابة على السلّة ──────────────────────────────────────────────────────

/** السلّة المفتوحة وحدها تُعدَّل — والمدفوعة تُرفض بالاسم لا برسالة عامة. */
async function requireOpen(id: number): Promise<SaleRow> {
  const sale = await repo.findSaleById(id);
  if (!sale) throw new NotFoundError('Sale not found');
  if (sale.status === 'paid') {
    throw new BusinessError(409, 'This sale is already paid', 'sale_already_paid');
  }
  if (sale.status === 'void') {
    throw new BusinessError(409, 'This sale was cancelled', 'sale_voided');
  }
  return sale;
}

export async function openSale(
  actor: RequestActorContext,
  input: { branch_id: number; customer_id?: number | null; customer_name?: string | null },
): Promise<WireSale> {
  const branch = await repo.findBranch(input.branch_id);
  if (!branch) throw new NotFoundError('Branch not found');
  const sale = await repo.insertSale({
    branch_id: input.branch_id,
    cashier_user_id: actor.userId,
    customer_id: input.customer_id ?? null,
    customer_name: input.customer_name ?? null,
  });
  return getSale(sale.id);
}

/**
 * يضيف صنفاً — **والسعر يُقرأ من الخادم لا من الجهاز**.
 *
 * ثمنٌ يرسله العميل هو خصمٌ يكتبه من يمسك الجهاز، ولا شيء بالفاتورة يقول أنه
 * اختُرع. والعرض يُطبَّق هنا أيضاً فيُجمَّد بالسطر: العرض الذي ينتهي منتصف
 * الطابور لا يغيّر سلّةً بُنيت قبله.
 */
export async function addLine(
  actor: RequestActorContext,
  saleId: number,
  input: { variant_id: number; qty: number; unit_id?: number | null },
): Promise<WireSale> {
  const sale = await requireOpen(saleId);
  const variant = await repo.findVariantForSale(input.variant_id);
  if (!variant) throw new NotFoundError('Variant not found');
  if (variant.status !== 'active') {
    throw new BusinessError(409, 'This product is not for sale', 'sale_product_not_sellable');
  }

  const prices = await resolvePricesAt(sale.branch_id, [input.variant_id], POS_PRICES);
  const price = prices.get(input.variant_id);
  if (!price || price.status !== 'priced' || price.amountSyp === null) {
    // «غير مسعَّر» عطلٌ عندنا لا حقيقة عن البضاعة — والكاشير يحتاج أن يعرف
    // أن الجواب تسعيرٌ لا إعادة مسح.
    throw new BusinessError(409, 'This item has no price at this branch', 'sale_item_unpriced');
  }

  const unitId = input.unit_id ?? variant.base_unit_id;
  const existing = await repo.findLineFor(saleId, input.variant_id, unitId);
  if (existing) {
    // مسحُ الصنف مرتين **يزيد الكمية**: سطران بخمسة يفوّتان شريحة العشرة،
    // ويقرأ الزبون صنفه مرتين بالإيصال.
    await repo.updateLine(db, existing.id, { qty: String(num(existing.qty) + input.qty) });
    return getSale(saleId);
  }

  await repo.insertLine({
    sale_id: saleId,
    variant_id: variant.variant_id,
    product_id: variant.product_id,
    name_ar: variant.name_ar,
    sku: variant.sku,
    unit_id: unitId,
    unit_factor: '1',
    qty: String(input.qty),
    unit_price_syp: String(price.promotion?.beforeSyp ?? price.amountSyp),
    promotion_discount_syp: String(
      price.promotion === null ? 0 : Math.max(0, price.promotion.beforeSyp - price.amountSyp),
    ),
    promotion_names: price.promotion === null ? null : price.promotion.names.join(' · '),
    tax_percent: String(price.taxPercent ?? 0),
  });
  return getSale(saleId);
}

export async function setLineQty(saleId: number, lineId: number, qty: number): Promise<WireSale> {
  await requireOpen(saleId);
  const line = await repo.findLineById(saleId, lineId);
  if (!line) throw new NotFoundError('Line not found');
  // كميةٌ صفر **تحذف السطر**: سطرٌ بصفر يُطبع بالإيصال ويُربك من يعدّ الأكياس.
  if (qty <= 0) await repo.deleteLine(saleId, lineId);
  else await repo.updateLine(db, lineId, { qty: String(qty) });
  return getSale(saleId);
}

export async function removeLine(saleId: number, lineId: number): Promise<WireSale> {
  await requireOpen(saleId);
  await repo.deleteLine(saleId, lineId);
  return getSale(saleId);
}

/** التعليق والاستئناف — **حالة لا حذف**: سلّةٌ مُعلَّقة تنتظر صاحبها. */
export async function setHeld(saleId: number, held: boolean): Promise<WireSale> {
  await requireOpen(saleId);
  await repo.updateSale(db, saleId, { status: held ? 'held' : 'open' });
  return getSale(saleId);
}

export async function voidSale(actor: RequestActorContext, saleId: number): Promise<WireSale> {
  const sale = await requireOpen(saleId);
  await db.transaction(async (tx) => {
    await repo.updateSale(tx, saleId, { status: 'void', voided_at: new Date() });
    // سلّةُ استلامٍ أُلغيت: الطلب يعود لانتظاره بمهلة جديدة. وتركُه مربوطاً
    // بفاتورة ملغاة يُجمّد بضاعته بلا مهلة تُسقطها أبداً.
    await reopenVoidedOrder(tx, saleId);
  });
  await recordAudit(actor, SALES_AUDIT.void, saleTarget.one(saleId), { status: sale.status }, {
    status: 'void',
  });
  return getSale(saleId);
}

// ── الخصم اليدوي (§٦) ───────────────────────────────────────────────────────

export interface DiscountCheck {
  cashier_cap_percent: number;
  max_approvable_percent: number;
  verdict: 'within_cap' | 'needs_approval' | 'refused';
}

export async function checkDiscount(userId: number, percent: number): Promise<DiscountCheck> {
  const [mine, ceiling] = await Promise.all([
    repo.findDiscountCapFor(userId),
    repo.findMaxApprovableCap(),
  ]);
  return {
    cashier_cap_percent: mine.cap,
    max_approvable_percent: ceiling,
    verdict: judgeDiscount(percent, mine.cap, ceiling).kind,
  };
}

/**
 * يضع الخصم — **والسبب إلزامي، والتجاوز يحمل اسم من وافق**.
 *
 * الموافق يُتحقَّق منه بكلمة مروره على نفس الجهاز (`approverUserId` يصل بعد
 * تحقّق المسار)، ويُكتب **بالفاتورة** لا بسجلّ جانبي: «بموافقة من؟» سؤالٌ
 * يُطرح على الفاتورة نفسها بعد شهور.
 */
export async function setDiscount(
  actor: RequestActorContext,
  saleId: number,
  input: { percent: number; reason: string; approver_user_id?: number | null },
): Promise<WireSale> {
  const sale = await requireOpen(saleId);
  const reason = input.reason.trim();
  if (input.percent > 0 && reason.length === 0) {
    throw new BusinessError(422, 'A manual discount needs a reason', 'sale_discount_reason_required');
  }

  const check = await checkDiscount(actor.userId, input.percent);
  if (check.verdict === 'refused') {
    throw new BusinessError(
      409,
      'This discount is above what anyone may approve',
      'sale_discount_above_ceiling',
      { max_percent: check.max_approvable_percent },
    );
  }

  let approver: number | null = null;
  if (check.verdict === 'needs_approval') {
    const approverId = input.approver_user_id ?? null;
    if (approverId === null) {
      throw new BusinessError(
        409,
        'This discount needs a manager approval',
        'sale_discount_needs_approval',
        { cap_percent: check.cashier_cap_percent },
      );
    }
    const theirs = await repo.findDiscountCapFor(approverId);
    // الموافق يجب أن يملك **هذا** الخصم لا مجرد صفة الموافقة: مديرٌ سقفه ١٥٪
    // لا يوافق على ٢٥٪، وإلا صارت الصفة مفتاحاً بلا حدّ.
    if (!theirs.canApprove || input.percent > theirs.cap + 1e-9) {
      throw new BusinessError(
        403,
        'This approver may not approve that much',
        'sale_approver_cap_too_low',
        { cap_percent: theirs.cap },
      );
    }
    approver = approverId;
  }

  await repo.updateSale(db, saleId, {
    discount_percent: String(input.percent),
    discount_reason: input.percent > 0 ? reason : null,
    discount_approved_by: approver,
  });
  await recordAudit(
    actor,
    SALES_AUDIT.discount,
    saleTarget.one(saleId),
    { discount_percent: num(sale.discount_percent) },
    { discount_percent: input.percent, reason, approved_by: approver },
  );
  return getSale(saleId);
}

// ── السداد ──────────────────────────────────────────────────────────────────

export interface PayInput {
  payments: PaymentInput[];
}

/**
 * يُقفل البيعة: يصرف الرقم · يجمّد المجاميع · يُخرج البضاعة · يقيّد الرصيد.
 *
 * **الأربعة بمعاملة واحدة.** فصلُ أيٍّ منها يترك فاتورةً لبضاعة ما زالت
 * بالدفتر، أو بضاعةً غادرت بلا ما يقول لمن — والدفتر يكفّ عن كونه قابلاً
 * لإعادة البناء، وهي الخاصّة الوحيدة التي وُجد لأجلها.
 */
export async function paySale(
  actor: RequestActorContext,
  saleId: number,
  input: PayInput,
): Promise<WireSale> {
  const preview = await requireOpen(saleId);
  const lines = await repo.findLines(saleId);
  if (lines.length === 0) {
    throw new BusinessError(422, 'An empty sale cannot be paid', 'sale_empty');
  }

  const totals = computeTotals(lines.map(toRuleLine), num(preview.discount_percent));
  const outcome = settle(input.payments, totals.totalSyp);
  if (outcome.remainingSyp > 0) {
    throw new BusinessError(422, 'The payments do not cover the sale', 'sale_underpaid', {
      remaining_syp: outcome.remainingSyp,
      total_syp: roundSyp(totals.totalSyp),
    });
  }

  const usingCredit = input.payments.filter(
    (p) => p.method === 'customer_credit' || p.method === 'on_account',
  );
  if (usingCredit.length > 0 && preview.customer_id === null) {
    // آجلٌ على «زبون عابر» دَينٌ على لا أحد.
    throw new BusinessError(422, 'Credit needs a named customer', 'sale_credit_needs_customer');
  }

  if (preview.customer_id !== null && usingCredit.length > 0) {
    const [balance, limit] = await Promise.all([
      repo.findCustomerBalance(preview.customer_id),
      repo.findCreditLimit(preview.customer_id),
    ]);
    const spent = input.payments
      .filter((p) => p.method === 'customer_credit')
      .reduce((sum, p) => sum + p.amountSyp, 0);
    const onAccount = input.payments
      .filter((p) => p.method === 'on_account')
      .reduce((sum, p) => sum + p.amountSyp, 0);
    if (spent > spendableCredit(balance) + 1e-9) {
      throw new BusinessError(422, 'Not enough customer credit', 'sale_credit_insufficient', {
        available_syp: roundSyp(spendableCredit(balance)),
      });
    }
    if (onAccount > creditAvailable(balance - spent, limit) + 1e-9) {
      throw new BusinessError(422, 'Above this customer credit limit', 'sale_credit_limit_exceeded', {
        available_syp: roundSyp(creditAvailable(balance - spent, limit)),
      });
    }
  }

  const branch = await repo.findBranch(preview.branch_id);
  const year = new Date().getFullYear();

  const paid = await db.transaction(async (tx) => {
    const locked = await repo.lockSale(tx, saleId);
    // بين الفحص والقفل قد يكون جهازٌ آخر سدّدها — والقفل هو ما يجعل الثانية
    // ترفض بدل أن تُخرج البضاعة مرتين.
    if (!locked || locked.status === 'paid') {
      throw new BusinessError(409, 'This sale is already paid', 'sale_already_paid');
    }

    const sequence = await repo.nextSequence(tx, preview.branch_id, year);
    const number = formatSaleNumber(
      branchPrefix(branch?.name ?? '', preview.branch_id),
      year,
      sequence,
    );

    for (let i = 0; i < lines.length; i += 1) {
      const amounts = totals.lines[i]!;
      await repo.updateLine(tx, lines[i]!.id, {
        manual_discount_syp: String(amounts.manualDiscountSyp),
        tax_syp: String(amounts.taxSyp),
        line_total_syp: String(amounts.lineTotalSyp),
      });
    }

    await repo.updateSale(tx, saleId, {
      status: 'paid',
      number,
      sequence,
      subtotal_syp: String(roundSyp(totals.subtotalSyp)),
      discount_syp: String(roundSyp(totals.discountSyp)),
      tax_syp: String(roundSyp(totals.taxSyp)),
      total_syp: String(roundSyp(totals.totalSyp)),
      paid_at: new Date(),
    });

    await repo.insertPayments(
      tx,
      input.payments.map((p) => ({
        sale_id: saleId,
        method: p.method,
        amount_syp: String(roundSyp(p.amountSyp)),
        tendered_syp: p.tenderedSyp === null || p.tenderedSyp === undefined ? null : String(p.tenderedSyp),
      })),
    );

    if (preview.customer_id !== null) {
      const entries = [];
      for (const p of input.payments) {
        // الإشارة تحمل المعنى: إنفاق الرصيد يُنقصه، والآجل دَينٌ عليه.
        if (p.method === 'customer_credit') {
          entries.push({
            customer_id: preview.customer_id,
            amount_syp: String(-roundSyp(p.amountSyp)),
            reason: 'credit_spent' as const,
            sale_id: saleId,
            created_by_user_id: actor.userId,
          });
        }
        if (p.method === 'on_account') {
          entries.push({
            customer_id: preview.customer_id,
            amount_syp: String(-roundSyp(p.amountSyp)),
            reason: 'sale_on_account' as const,
            sale_id: saleId,
            created_by_user_id: actor.userId,
          });
        }
      }
      await repo.insertLedgerEntries(tx, entries);
    }

    // البضاعة تغادر **بنفس المعاملة** — والكمية بوحدة الأساس.
    await issueStock({
      exec: tx,
      branchId: preview.branch_id,
      lines: lines.map((line) => ({
        variantId: line.variant_id,
        qtyBase: num(line.qty) * num(line.unit_factor),
      })),
      docType: 'sale',
      docId: saleId,
      userId: actor.userId,
    });

    // **الطلب يُقفل بنفس معاملة الدفع** حين تكون هذه فاتورة استلامه: حجزُه
    // يُحرَّر هنا تماماً حيث يُخصم `on_hand`، وإلا خُصمت البضاعة مرتين —
    // مرة من الرفّ ومرة من المتاح — فيكفّ الصنف عن الظهور للبيع وهو موجود.
    await closePaidOrder(tx, saleId);

    return number;
  });

  await recordAudit(actor, SALES_AUDIT.pay, saleTarget.one(saleId), null, {
    number: paid,
    total_syp: roundSyp(totals.totalSyp),
  });
  return getSale(saleId);
}

// ── السقوف ورصيد الزبون ─────────────────────────────────────────────────────

export async function getCaps() {
  const rows = await repo.findAllCaps();
  return {
    roles: rows.map((r) => ({
      role_id: r.role_id,
      max_discount_percent: Number(r.max_discount_percent),
      can_approve: r.can_approve,
    })),
  };
}

export async function setCap(
  actor: RequestActorContext,
  input: { role_id: number; max_discount_percent: number; can_approve: boolean },
) {
  await repo.upsertCap(
    input.role_id,
    String(input.max_discount_percent),
    input.can_approve,
    actor.userId,
  );
  await recordAudit(actor, SALES_AUDIT.capSet, saleTarget.caps(), null, input);
  return getCaps();
}

export async function getCustomerAccount(customerId: number) {
  const [balance, limit, entries] = await Promise.all([
    repo.findCustomerBalance(customerId),
    repo.findCreditLimit(customerId),
    repo.findLedger(customerId, 50),
  ]);
  return {
    customer_id: customerId,
    balance_syp: roundSyp(balance),
    limit_syp: limit,
    spendable_syp: roundSyp(spendableCredit(balance)),
    available_credit_syp: roundSyp(creditAvailable(balance, limit)),
    entries: entries.map((e) => ({
      id: e.id,
      amount_syp: Number(e.amount_syp),
      reason: e.reason,
      sale_id: e.sale_id,
      note: e.note,
      created_at: e.created_at.toISOString(),
    })),
  };
}

export async function setCreditLimit(
  actor: RequestActorContext,
  customerId: number,
  limit: number,
) {
  await repo.upsertCreditLimit(customerId, String(limit), actor.userId);
  await recordAudit(actor, SALES_AUDIT.creditLimit, saleTarget.customer(customerId), null, {
    limit_syp: limit,
  });
  return getCustomerAccount(customerId);
}

/** تسديد ذمّة أو إيداع رصيد — قيدٌ يدوي بسببه ومن كتبه. */
export async function adjustCustomerLedger(
  actor: RequestActorContext,
  customerId: number,
  input: { amount_syp: number; note: string },
) {
  if (input.amount_syp === 0) {
    throw new BusinessError(422, 'A ledger entry needs an amount', 'ledger_amount_required');
  }
  await repo.insertLedgerEntries(db, [
    {
      customer_id: customerId,
      amount_syp: String(roundSyp(input.amount_syp)),
      reason: 'manual_adjustment',
      note: input.note.trim() || null,
      created_by_user_id: actor.userId,
    },
  ]);
  await recordAudit(actor, SALES_AUDIT.ledgerAdjust, saleTarget.customer(customerId), null, input);
  return getCustomerAccount(customerId);
}
