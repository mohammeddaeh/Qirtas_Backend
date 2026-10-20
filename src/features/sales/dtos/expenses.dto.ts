import { z } from 'zod';
import { paginationQuerySchema } from '../../../core/pagination/pagination.js';

/** المصاريف والرواتب — `finance_operations.md` §٢. */

const id = z.coerce.number().int().positive();
const amount = z.number().positive().max(1_000_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-\d{2}$/);

export const expenseCategoryBodySchema = z
  .object({
    name_ar: z.string().trim().min(2).max(80),
    name_en: z.string().trim().max(80).optional(),
    kind: z.enum(['operating', 'salary']).default('operating'),
  })
  .strict();

export const expenseCategoryPatchSchema = z
  .object({
    name_ar: z.string().trim().min(2).max(80).optional(),
    name_en: z.string().trim().max(80).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

export const categoriesQuerySchema = z.object({ include_inactive: z.enum(['true']).optional() }).strict();

export const expensesQuerySchema = paginationQuerySchema
  .extend({
    branch_id: id.optional(),
    category_id: id.optional(),
    employee_id: id.optional(),
    from: day.optional(),
    to: day.optional(),
  })
  .strict();

export const expenseBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    category_id: z.number().int().positive(),
    amount_syp: amount,
    source: z.enum(['drawer', 'outside']),
    spent_on: day.optional(),
    note: z.string().trim().max(300).optional(),
    receipt_media_id: z.number().int().positive().optional(),
    employee_user_id: z.number().int().positive().optional(),
    salary_kind: z.enum(['salary', 'advance']).optional(),
    period: month.optional(),
    recurring_id: z.number().int().positive().optional(),
    /** From the drawer above the cap — the manager approves on this device. */
    approver_email: z.string().trim().email().optional(),
    approver_password: z.string().min(1).optional(),
  })
  .strict();

export const expenseReverseBodySchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

export const recurringQuerySchema = z.object({ include_inactive: z.enum(['true']).optional() }).strict();

export const recurringBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    category_id: z.number().int().positive(),
    amount_syp: amount,
    day_of_month: z.number().int().min(1).max(28),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export const recurringPatchSchema = z
  .object({
    amount_syp: amount.optional(),
    day_of_month: z.number().int().min(1).max(28).optional(),
    note: z.string().trim().max(300).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

export const wagesQuerySchema = z.object({ branch_id: id.optional() }).strict();

export const userIdParamsSchema = z.object({ userId: id }).strict();

export const wageBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    amount_syp: amount,
    frequency: z.enum(['monthly', 'weekly', 'daily']).default('monthly'),
    due_day: z.number().int().min(1).max(28).default(1),
    effective_from: day.optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export const wageEndBodySchema = z.object({ ended_on: day.optional() }).strict();

export type ExpensesQuery = z.infer<typeof expensesQuerySchema>;
