import { publicImagesByIds } from '../../../core/media/media.service.js';
import * as repo from '../repositories/sales.repository.js';

/**
 * صورة كل صنف: صورة المتغيّر نفسه إن وُجدت، وإلا أول صور المنتج — الترتيب
 * ترتيب المعرض (`sort_order`)، فالغلاف الذي اختارته الإدارة أولاً هو ما يُرى.
 */
export async function thumbnailsFor(
  items: { productId: number | null; variantId: number | null }[],
): Promise<(string | null)[]> {
  const productIds = items.flatMap((i) => (i.productId === null ? [] : [i.productId]));
  if (productIds.length === 0) return items.map(() => null);
  const links = await repo.findProductMedia(productIds);
  const images = await publicImagesByIds(links.map((l) => l.media_id));
  return items.map(({ productId, variantId }) => {
    if (productId === null) return null;
    const own = links.filter((l) => l.product_id === productId);
    const pick =
      own.find((l) => l.variant_id !== null && l.variant_id === variantId) ??
      own.find((l) => l.variant_id === null) ??
      own[0];
    return pick === undefined ? null : (images.get(pick.media_id)?.urls.thumb ?? null);
  });
}
