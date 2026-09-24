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
} as const;

export const saleTarget = {
  one: (id: number) => `sale:${id}`,
  caps: () => 'sale_discount_caps',
  customer: (id: number) => `customer_account:${id}`,
};
