import type { Request, Response } from 'express';
import { created, noContentOk, ok } from '../../../core/http/response.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import * as collectionsService from '../services/collections.service.js';
import type { IdParams } from '../dtos/common.dto.js';
import type {
  CreateCollectionBody,
  ReplaceCollectionProductsBody,
  UpdateCollectionBody,
} from '../dtos/collections.dto.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idOf = (req: Request) => (req.params as unknown as IdParams).id;

export async function listCollections(_req: Request, res: Response): Promise<void> {
  ok(res, await collectionsService.listCollections());
}

export async function getCollection(req: Request, res: Response): Promise<void> {
  ok(res, await collectionsService.getCollection(idOf(req)));
}

export async function createCollection(req: Request, res: Response): Promise<void> {
  created(
    res,
    await collectionsService.createCollection(actorOf(req), req.body as CreateCollectionBody),
  );
}

export async function updateCollection(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateCollectionBody;
  ok(res, await collectionsService.updateCollection(actorOf(req), idOf(req), body));
}

export async function replaceCollectionProducts(req: Request, res: Response): Promise<void> {
  const body = req.body as ReplaceCollectionProductsBody;
  ok(res, await collectionsService.replaceCollectionProducts(actorOf(req), idOf(req), body));
}

export async function deleteCollection(req: Request, res: Response): Promise<void> {
  await collectionsService.deleteCollection(actorOf(req), idOf(req));
  noContentOk(res);
}
