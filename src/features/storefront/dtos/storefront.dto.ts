import { z } from 'zod';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';
import type { WireImage } from '../../../core/media/media.service.js';
import type { PublicAvailability } from '../services/availability-rules.js';

/** What a customer sees — store_system.md §٨, rest_api.md §25. */

const branchId = z.coerce.number().int().positive();

/**
 * Where the customer is, when they chose to say. Optional and **half is not
 * accepted**: one coordinate without the other would place them on the equator
 * and name the wrong «أقرب فرع».
 */
const coordinates = {
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
};

const bothCoordinates = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine((q: { lat?: number; lng?: number }) => (q.lat === undefined) === (q.lng === undefined), {
    message: 'Send both coordinates or neither',
    path: ['lat'],
  });

/** The shape itself — what the generated docs describe. */
export const storefrontBranchShape = z.object({ branch_id: branchId, ...coordinates }).strict();

/**
 * What `validate()` enforces. The refinement lives **here and not on the
 * shape**, because `.merge()` is only defined on an object schema: merging
 * pagination into a refined schema would have meant unwrapping it, and the
 * unwrapped copy silently drops the check — a half coordinate then travels
 * all the way to the equator with a 200 beside it.
 */
export const storefrontBranchQuerySchema = bothCoordinates(storefrontBranchShape);

export const storefrontProductsShape = z
  .object({
    branch_id: branchId,
    category_id: z.coerce.number().int().positive().optional(),
    collection_id: z.coerce.number().int().positive().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    ...coordinates,
  })
  .strict();

export const storefrontProductsQuerySchema = bothCoordinates(
  paginationQuerySchema.merge(storefrontProductsShape).strict(),
);
export type StorefrontProductsQuery = z.infer<typeof storefrontProductsQuerySchema>;

// ── «أعلمني» و«اطلب توفيره بفرعي» (§٨) ──────────────────────────────────────

export const demandBodySchema = z
  .object({
    variant_id: z.number().int().positive(),
    branch_id: z.number().int().positive(),
    kind: z.enum(['notify', 'request_here']),
  })
  .strict();
export type DemandBody = z.infer<typeof demandBodySchema>;

export const demandSummaryQuerySchema = z.object({ branch_id: branchId }).strict();

/** طلبٌ واحد للزبون — الشاشة تعرف به أن الزرّ صار «أُلغِ الطلب». */
export interface WireDemand {
  id: number;
  variant_id: number;
  branch_id: number;
  kind: 'notify' | 'request_here';
  created_at: string;
}

/**
 * ما ينتظره الزبائن بصنف واحد — **مجمَّعاً**: «١٢ زبوناً طلبوا X» رقمٌ
 * يتصرّف به المدير، واثنا عشر صفاً منفصلاً قائمةٌ تُغلق.
 */
export interface WireDemandSummaryRow {
  variant_id: number;
  product_id: number;
  product_name_ar: string;
  sku: string;
  /** «نفد بكل مكان» — الجواب شراءٌ من المورد. */
  notify_count: number;
  /** «موجود بفرع آخر» — الجواب نقل. */
  request_count: number;
  /** عمر أقدم طلب بالأيام: الرقم وحده لا يقول من يُنسى. */
  waiting_days: number;
  /** ما على الرف الآن — طلبٌ لبضاعة وصلت يُغلق بلا نقل ولا شراء. */
  on_hand: number;
}

/** بديلٌ يُقترح بجانب حالةٍ غير متاحة (§٨). */
export interface WireAlternative {
  product_id: number;
  name_ar: string;
  name_en: string | null;
  price_syp: number;
  thumbnail: WireImage | null;
}

export interface WireStorefrontCategory {
  id: number;
  parent_id: number | null;
  level: number;
  name_ar: string;
  name_en: string | null;
  /** Live products under this category **and its descendants** — a category a
   *  customer opens to find nothing is a dead end, so the client may hide it. */
  product_count: number;
}

export interface WireStorefrontCollection {
  id: number;
  name_ar: string;
  name_en: string | null;
  image: WireImage | null;
  product_count: number;
}

export interface WireOtherBranch {
  id: number;
  name: string;
  /** `null` when the customer did not share where they are, or the branch has
   *  no coordinates — the name alone is still worth saying. */
  distance_km: number | null;
}

/**
 * A price as the customer may act on it.
 *
 * `wholesale` travels **only** to a buyer the administration approved
 * (`customers.wholesale`), and always beside the retail amount: a buyer shown
 * one number cannot tell what their approval is worth, and a buyer shown a
 * price they cannot pay with meets the refusal at checkout instead.
 */
export interface WireStorefrontPrice {
  amount_syp: number;
  wholesale: { amount_syp: number; min_qty: number } | null;
  /**
   * السعر قبل العرض، واسم ما خفّضه (§٥). `null` = لا عرض — وليست صفراً: بطاقةٌ
   * تقول «خصم ٠ ل.س» تُقرأ عرضاً وتُرسل من يبحث عنه.
   *
   * والاسم يسافر مع الرقم لأن «٥٬٠٠٠ بدل ٦٬٠٠٠» بلا سبب تُقرأ خطأً بالسعر،
   * و«عودة المدارس» تقول إنها تنتهي.
   */
  was_syp: number | null;
  promotion_names: string[];
}

export interface WireStorefrontProduct {
  id: number;
  name_ar: string;
  name_en: string | null;
  brand_name: string | null;
  category_id: number;
  thumbnail: WireImage | null;
  /** The best of its variants' states (§٨): one colour out of five being out
   *  is not «نفد», and saying so would hide four colours that are on the shelf. */
  availability: PublicAvailability;
  /** The cheapest sellable variant here — what «يبدأ من» is drawn from. */
  price: WireStorefrontPrice | null;
  /** Only with `low_stock`. */
  remaining: number | null;
  /** Only with `out_here_available_elsewhere` / `not_listed_here`. */
  other_branch: WireOtherBranch | null;
  variant_count: number;
}

export interface WireStorefrontUnit {
  unit_id: number;
  name_ar: string;
  factor: number;
  is_base: boolean;
  /** The price of one of **this** unit, already resolved (a carton is not
   *  always twelve times a piece — §٩ allows an override). */
  price_syp: number | null;
}

export interface WireStorefrontVariant {
  variant_id: number;
  sku: string;
  label_ar: string;
  images: WireImage[];
  availability: PublicAvailability;
  price: WireStorefrontPrice | null;
  remaining: number | null;
  other_branch: WireOtherBranch | null;
  units: WireStorefrontUnit[];
}

export interface WireStorefrontProductDetail {
  id: number;
  name_ar: string;
  name_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  brand_name: string | null;
  category_id: number;
  category_name_ar: string;
  images: WireImage[];
  availability: PublicAvailability;
  /** The rate on the receipt, for a shop that shows tax-inclusive prices (§١١). */
  tax_percent: number | null;
  variants: WireStorefrontVariant[];
  /**
   * بدائل **لا تُرسل إلا حين لا يستطيع الزبون الشراء هنا** (§٨): اقتراحٌ
   * بجانب بضاعة متوفّرة تزاحم ما جاء الزبون لأجله، وبجانب «نفد» هو الفرق
   * بين طريق مسدود وبيعٍ آخر.
   */
  alternatives: WireAlternative[];
  /** ما سجّله هذا الزبون على هذا المنتج بهذا الفرع — فارغة للضيف. */
  my_requests: WireDemand[];
}
