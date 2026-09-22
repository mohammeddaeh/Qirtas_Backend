import type { Request, Response } from 'express';
import { created, noContentOk, ok } from '../../../core/http/response.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import * as productsService from '../services/products.service.js';
import type { IdParams } from '../dtos/common.dto.js';
import type {
  AddBarcodeBody,
  CreateProductBody,
  GenerateBarcodeBody,
  ProductsFilterQuery,
  ReplaceVariantUnitsBody,
  UpdateProductBody,
  UpdateVariantBody,
  VariantInput,
} from '../dtos/products.dto.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idOf = (req: Request) => (req.params as unknown as IdParams).id;

export async function listProducts(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { page: number; limit: number } & ProductsFilterQuery;
  ok(res, await productsService.listProducts(toPaginationParams(query), query));
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  ok(res, await productsService.getProduct(idOf(req)));
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  created(res, await productsService.createProduct(actorOf(req), req.body as CreateProductBody));
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await productsService.updateProduct(actorOf(req), idOf(req), req.body as UpdateProductBody),
  );
}

export async function deleteProduct(req: Request, res: Response): Promise<void> {
  await productsService.deleteProduct(actorOf(req), idOf(req));
  noContentOk(res);
}

export async function archiveProduct(req: Request, res: Response): Promise<void> {
  ok(res, await productsService.archiveProduct(actorOf(req), idOf(req)));
}

export async function unarchiveProduct(req: Request, res: Response): Promise<void> {
  ok(res, await productsService.unarchiveProduct(actorOf(req), idOf(req)));
}

export async function addVariant(req: Request, res: Response): Promise<void> {
  created(res, await productsService.addVariant(actorOf(req), idOf(req), req.body as VariantInput));
}

export async function updateVariant(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await productsService.updateVariant(actorOf(req), idOf(req), req.body as UpdateVariantBody),
  );
}

export async function deleteVariant(req: Request, res: Response): Promise<void> {
  ok(res, await productsService.deleteVariant(actorOf(req), idOf(req)));
}

export async function replaceVariantUnits(req: Request, res: Response): Promise<void> {
  const body = req.body as ReplaceVariantUnitsBody;
  ok(res, await productsService.replaceVariantUnits(actorOf(req), idOf(req), body));
}

export async function addBarcode(req: Request, res: Response): Promise<void> {
  created(
    res,
    await productsService.addBarcode(actorOf(req), idOf(req), req.body as AddBarcodeBody),
  );
}

export async function generateBarcode(req: Request, res: Response): Promise<void> {
  const body = req.body as GenerateBarcodeBody;
  created(res, await productsService.generateInternalBarcode(actorOf(req), idOf(req), body));
}

export async function deleteBarcode(req: Request, res: Response): Promise<void> {
  ok(res, await productsService.deleteBarcode(actorOf(req), idOf(req)));
}

export async function lookupBarcode(req: Request, res: Response): Promise<void> {
  const { code } = req.query as unknown as { code: string };
  ok(res, await productsService.lookupBarcode(code));
}

export async function listSharedBarcodes(_req: Request, res: Response): Promise<void> {
  ok(res, await productsService.listSharedBarcodes());
}
