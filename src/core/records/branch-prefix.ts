/**
 * بادئة الفرع من اسمه: أول حرفين لاتينيين، وإلا `BR<id>`.
 *
 * الاسم العربي لا يُشتقّ منه حرفان لاتينيان، ورقمُ الفرع جوابٌ صادق يبقى
 * فريداً — بخلاف بادئةٍ مخترَعة يتشاركها فرعان فيتصادم رقماهما.
 *
 * بـ`core/` لأن كل ترقيم بفرع يبدأ بها (الفواتير والطلبات بـ`sales`، وطلبات
 * الطباعة بـ`printing`) — ونسختان تختلفان أول تعديل فيبدأ رقمان لنفس الفرع
 * ببادئتين.
 */
export function branchPrefix(name: string, branchId: number): string {
  const letters = name.replace(/[^A-Za-z]/g, '');
  return letters.length >= 2 ? letters.slice(0, 2).toUpperCase() : `BR${branchId}`;
}
