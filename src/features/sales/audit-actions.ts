/**
 * أفعال البيع بسجلّ التدقيق.
 *
 * «من خصم ١٥٪ على فاتورة أمس، وبموافقة من؟» سؤالٌ يُطرح بعد شهور — وجوابه
 * هنا، بجانب ما تحمله الفاتورة نفسها.
 */
export const SALES_AUDIT = {
  pay: 'sales.pay',
  void: 'sales.void',
  discount: 'sales.discount',
  capSet: 'sales.cap.set',
  creditLimit: 'sales.credit_limit.set',
  ledgerAdjust: 'sales.ledger.adjust',
  ledgerReverse: 'sales.ledger.reverse',
  debtPay: 'sales.debt.pay',
  creditSettings: 'sales.credit_settings.set',
  expenseCreate: 'expenses.create',
  expenseReverse: 'expenses.reverse',
  expenseCategory: 'expenses.category.set',
  expenseRecurring: 'expenses.recurring.set',
  wageSet: 'expenses.wage.set',
  refund: 'sales.refund',
  settings: 'sales.settings.set',
  orderPickup: 'sales.order.pickup',
  orderCancel: 'sales.order.cancel',
  shiftOpen: 'sales.shift.open',
  shiftMovement: 'sales.shift.movement',
  shiftClose: 'sales.shift.close',
  shiftReason: 'sales.shift.reason',
  shiftReverse: 'sales.shift.reverse',
  shiftReview: 'sales.shift.review',
} as const;

export const saleTarget = {
  one: (id: number) => `sale:${id}`,
  caps: () => 'sale_discount_caps',
  customer: (id: number) => `customer_account:${id}`,
  return_: (id: number) => `sale_return:${id}`,
  settings: () => 'sales_settings',
  order: (id: number) => `order:${id}`,
  shift: (id: number) => `cash_shift:${id}`,
  expense: (id: number) => `expense:${id}`,
  expenseCategory: (id: number) => `expense_category:${id}`,
  recurring: (id: number) => `recurring_expense:${id}`,
  wage: (userId: number) => `employee_wage:${userId}`,
};
