import { z } from 'zod';
import { CONSUMPTION_BASES } from '../schemas/print-consumption.schema.js';

/** وصفة الاستهلاك — `qirtas_backend/docs/rest_api.md` §31. */

const id = z.coerce.number().int().positive();

/**
 * قاعدة: خيارٌ × مادة × أساس — **كمية أو مردود، لا الاثنان** (الخدمة تفحص
 * الاجتماع، والـCHECK بالقاعدة شبكة ثانية).
 */
const ruleSchema = z
  .object({
    option_id: id,
    variant_id: id,
    basis: z.enum(CONSUMPTION_BASES),
    qty: z.number().positive().max(100_000).nullable().default(null),
    yield_pages: z.number().int().min(1).max(10_000_000).nullable().default(null),
  })
  .strict();

/** الوصفة **كاملة** — ما يغيب يُحذف (الاستبدال لا الترقيع). */
export const rulesBodySchema = z.object({ rules: z.array(ruleSchema).max(500) }).strict();

export const materialsQuerySchema = z
  .object({ search: z.string().trim().min(1).max(100) })
  .strict();

export const consumablesQuerySchema = z.object({ branch_id: id }).strict();

export const consumableParamsSchema = z.object({ variantId: id }).strict();

/** ما استُهلك فعلاً بوحدة أساس المادة — علبة واحدة افتراضاً. */
export const installBodySchema = z
  .object({
    branch_id: id,
    actual: z.number().positive().max(1000).optional(),
  })
  .strict();

export type RulesBody = z.infer<typeof rulesBodySchema>;
export type InstallBody = z.infer<typeof installBodySchema>;
