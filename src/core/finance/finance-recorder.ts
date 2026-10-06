import type { db } from '../db/client.js';
import {
  financeEntriesTable,
  type FinanceDocType,
  type FinanceEntryType,
  type FinanceMethod,
} from './schemas/finance-entries.schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type FinanceExec = typeof db | Tx;

/**
 * يكتب قيود السجل المالي **بمعاملة الحدث نفسه** (`finance_ledger.md` §٢):
 * فاتورةٌ سُدِّدت بلا قيد إيرادها تقريرٌ ينقص بلا أي فشل، وقيدٌ بلا فاتورة
 * إيرادٌ لم يحدث.
 *
 * القيد الصفري لا يُكتب (سطر طباعة بلا وصفة مواد، تكلفة غير معروفة) — صفّ
 * يقول «صفر» لا يضيف إلى أي تقرير إلا الضجيج.
 */
export interface FinanceEntry {
  branchId: number;
  type: FinanceEntryType;
  method: FinanceMethod;
  /** بإشارته: موجبٌ داخل/قيمة، سالبٌ خارج/كلفة/خسارة. */
  amountSyp: number;
  docType: FinanceDocType;
  docId: number;
  saleId?: number | null;
  userId?: number | null;
  reason?: string | null;
  note?: string | null;
}

export const round2 = (v: number): number => Math.round(v * 100) / 100;

export async function recordFinance(exec: FinanceExec, entries: FinanceEntry[]): Promise<void> {
  const rows = entries
    .map((e) => ({ ...e, amountSyp: round2(e.amountSyp) }))
    .filter((e) => e.amountSyp !== 0)
    .map((e) => ({
      branch_id: e.branchId,
      type: e.type,
      method: e.method,
      amount_syp: e.amountSyp.toFixed(2),
      doc_type: e.docType,
      doc_id: e.docId,
      sale_id: e.saleId ?? null,
      user_id: e.userId ?? null,
      reason: e.reason ?? null,
      note: e.note ?? null,
    }));
  if (rows.length === 0) return;
  await exec.insert(financeEntriesTable).values(rows);
}

export type PaymentMethod = Exclude<FinanceMethod, 'value'>;

/**
 * الإيراد بطريقة دفعه، **ومجموعه الفاتورة لا ما سُلِّم**: ما زاد نقداً باقٍ
 * يعود للزبون، وقيدُه إيراداً يجعل الدرج والتقرير يختلفان بالباقي نفسه.
 * يُقصّ بالترتيب حتى يبلغ المجموع، والنقد أولاً يُقصّ لأنه وحده يُرجع فكّة.
 */
export function allocateRevenue(
  payments: { method: PaymentMethod; amountSyp: number }[],
  totalSyp: number,
): { method: PaymentMethod; amountSyp: number }[] {
  const ordered = [
    ...payments.filter((p) => p.method !== 'cash'),
    ...payments.filter((p) => p.method === 'cash'),
  ];
  let left = round2(Math.max(0, totalSyp));
  const out: { method: PaymentMethod; amountSyp: number }[] = [];
  for (const p of ordered) {
    const take = round2(Math.min(Math.max(0, p.amountSyp), left));
    left = round2(left - take);
    if (take > 0) out.push({ method: p.method, amountSyp: take });
  }
  return out;
}
