/**
 * أفعال العروض بسجلّ التدقيق. «لماذا بِعنا بهذا السعر؟» سؤالٌ يُطرح بعد شهور،
 * وجوابه من · متى · وبأي قاعدة.
 */
export const PROMOTION_AUDIT = {
  create: 'promotions.create',
  update: 'promotions.update',
  delete: 'promotions.delete',
  archive: 'promotions.archive',
  unarchive: 'promotions.unarchive',
  capSet: 'promotions.cap.set',
} as const;

export const promotionTarget = {
  one: (id: number) => `promotion:${id}`,
  caps: () => 'promotion_caps',
};
