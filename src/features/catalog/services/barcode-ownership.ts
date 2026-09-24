import { BusinessError } from '../../../core/http/api-error.js';
import * as productsRepository from '../repositories/products.repository.js';

/**
 * One code, one product — the limit on the sharing `barcode-rules.ts` accepts.
 *
 * Inside a product a repeated code is the factory case §٧ was built for (the
 * piece, the box and the carton, or every colour of one pen), and the scanner
 * resolves it with one tap: the item is settled, only the unit or the colour
 * is being asked. On a **second product** the same tap resolves nothing — the
 * cashier holds one thing and the screen offers two unrelated ones, with
 * nothing on the shelf to tell them apart. So it is refused at every door that
 * can write a barcode: add · create product · add variant · branch draft.
 *
 * The refusal names the owning product, because the next step is to open it —
 * not to retype the same number.
 *
 * Archived products are left out: a scan does not offer them either, so a code
 * on a retired item is free to be reused.
 */
export async function assertCodesFreeOfOtherProducts(
  codes: string[],
  productId: number | null,
): Promise<void> {
  const owners = await productsRepository.findProductsCarryingCodes(
    [...new Set(codes)],
    productId,
  );
  const clash = owners[0];
  if (!clash) return;
  throw new BusinessError(
    409,
    `Barcode ${clash.code} is already on another product`,
    'barcode_on_other_product',
    {
      code: clash.code,
      product_id: clash.productId,
      product_name_ar: clash.nameAr,
      product_name_en: clash.nameEn,
    },
  );
}
