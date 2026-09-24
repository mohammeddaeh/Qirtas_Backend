import { z } from 'zod';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';

/** السلّة والطلب الإلكتروني — `qirtas_backend/docs/rest_api.md` §28. */

const id = z.coerce.number().int().positive();

/**
 * الفرع **إلزامي بكل نداء سلّة**.
 *
 * السلّة واحدة لكل (زبون × فرع)، والفرع يُنفّذ السطر. افتراضُه هنا يجعل زبوناً
 * بدّل فرعه يضيف إلى سلّة فرعٍ لا ينظر إليه — ويؤكّدها هناك.
 */
export const cartQuerySchema = z.object({ branch_id: id }).strict();

export const cartItemBodySchema = z
  .object({
    variant_id: id,
    qty: z.number().positive().max(10000),
  })
  .strict();

export const cartQtyBodySchema = z
  .object({
    variant_id: id,
    /** صفرٌ **يحذف السطر** — سطرٌ بصفر يبقى بالمراجعة ويُقرأ «طلبته ولم يصل». */
    qty: z.number().min(0).max(10000),
  })
  .strict();

export const checkoutBodySchema = z
  .object({
    branch_id: id,
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const cancelOrderBodySchema = z
  .object({
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const ordersQuerySchema = paginationQuerySchema
  .extend({
    branch_id: id.optional(),
    customer_id: id.optional(),
    status: z.enum(['pending_pickup', 'picked_up', 'cancelled', 'expired']).optional(),
  })
  .strict();

export const myOrdersQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(['pending_pickup', 'picked_up', 'cancelled', 'expired']).optional(),
  })
  .strict();

export type CartItemBody = z.infer<typeof cartItemBodySchema>;
export type CartQtyBody = z.infer<typeof cartQtyBodySchema>;
export type CheckoutBody = z.infer<typeof checkoutBodySchema>;
export type OrdersQuery = z.infer<typeof ordersQuerySchema>;
export type MyOrdersQuery = z.infer<typeof myOrdersQuerySchema>;
