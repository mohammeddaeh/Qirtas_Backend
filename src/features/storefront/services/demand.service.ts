import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { DemandBody, WireDemand, WireDemandSummaryRow } from '../dtos/storefront.dto.js';
import * as demandRepository from '../repositories/demand.repository.js';
import * as repository from '../repositories/storefront.repository.js';
import type { StorefrontDemandRow } from '../schemas/demand.schema.js';

/**
 * «أعلمني عند التوفّر» و«اطلب توفيره بفرعي» — store_system.md §٨.
 *
 * الغاية واحدة: **النقص يصير معلومة يتصرّف بها أحد**. بلا هذا، «نفد حالياً»
 * نهايةُ الحديث — يغادر الزبون ولا يعرف أحد أنه جاء، ويُعاد طلب البضاعة حين
 * يلاحظ أحدهم صدفةً.
 *
 * **وللمسجَّل وحده** (قرار 2026-09-23): الإشعار يصل بقناة الحساب القائمة
 * (FCM + بريد)، ورقمٌ يكتبه ضيف يفتح قناة ثانية غير مبنيّة وبيانات اتصال بلا
 * صاحب يمحوها.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function toWire(row: StorefrontDemandRow): WireDemand {
  return {
    id: row.id,
    variant_id: row.variant_id,
    branch_id: row.branch_id,
    kind: row.kind,
    created_at: row.created_at.toISOString(),
  };
}

export async function recordDemand(customerId: number, body: DemandBody): Promise<WireDemand> {
  const branch = await repository.findBranch(body.branch_id);
  if (!branch || branch.archived_at !== null || branch.status !== 'active') {
    throw new BusinessError(404, 'This branch is not open for shopping', 'branch_not_shoppable');
  }
  const variant = await repository.findSellableVariant(body.variant_id);
  // صنفٌ لا يُباع أصلاً: الطلب عليه لا يقول شيئاً لأحد، ولا يصحّ أن يُعدّ
  // بطابور المدير.
  if (!variant) throw new NotFoundError('Variant not found');

  return toWire(
    await demandRepository.upsertDemand({
      variant_id: body.variant_id,
      branch_id: body.branch_id,
      customer_id: customerId,
      kind: body.kind,
    }),
  );
}

export async function cancelDemand(customerId: number, id: number): Promise<void> {
  const removed = await demandRepository.deleteDemand(customerId, id);
  // طلبُ غيرك لا يُحذف، وغير الموجود ليس خطأ خادم: كلاهما «لا شيء هنا لك».
  if (removed === 0) throw new NotFoundError('Request not found');
}

export async function listMine(customerId: number, branchId: number): Promise<WireDemand[]> {
  const rows = await demandRepository.findMineAt(customerId, branchId);
  return rows.map(toWire);
}

/**
 * ما ينتظره الزبائن بفرع واحد — للمدير.
 *
 * مجمَّع لكل صنف ومرتَّب بالأقدم: «١٢ زبوناً طلبوا X منذ ٩ أيام» جملةٌ تُقرأ
 * قراراً (نقلٌ أو شراء)، بينما اثنا عشر صفاً هي قائمةٌ تُغلق. و`on_hand` معها
 * لأن الطلب قد يكون أُجيب بالفعل: بضاعة وصلت أمس تُغلق الطابور بلا أي أمر.
 */
export async function summariseDemand(branchId: number, limit = 50): Promise<WireDemandSummaryRow[]> {
  const rows = await demandRepository.findDemandSummary(branchId, limit);
  const now = Date.now();
  return rows.map((row) => ({
    variant_id: row.variant_id,
    product_id: row.product_id,
    product_name_ar: row.product_name_ar,
    sku: row.sku,
    notify_count: Number(row.notify_count),
    request_count: Number(row.request_count),
    waiting_days: row.first_asked_at
      ? Math.floor((now - new Date(row.first_asked_at).getTime()) / DAY_MS)
      : 0,
    on_hand: row.on_hand === null ? 0 : Number(row.on_hand),
  }));
}
