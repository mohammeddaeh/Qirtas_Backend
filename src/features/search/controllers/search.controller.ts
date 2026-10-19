import type { Request, Response } from 'express';
import { ok } from '../../../core/http/response.js';
import { requireActorId } from '../../../core/http/require-actor.js';
import type { SearchQuery } from '../dtos/search.dto.js';
import * as service from '../services/search.service.js';

export async function search(req: Request, res: Response): Promise<void> {
  const { q } = req.query as unknown as SearchQuery;
  ok(res, await service.search(requireActorId(req), q));
}
