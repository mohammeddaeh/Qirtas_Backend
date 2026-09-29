import type { Request, Response } from 'express';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { created, noContentOk, ok } from '../../../core/http/response.js';
import * as mediaService from '../../../core/media/media.service.js';
import type {
  CreateTemplateBody,
  LabelsBody,
  ProfileBody,
  UpdateTemplateBody,
} from '../dtos/documents.dto.js';
import type { DocumentKind } from '../dtos/layout.schema.js';
import * as service from '../services/documents.service.js';

const actorOf = (req: Request) => buildActorContext(req, requireActorId(req));
const idParam = (req: Request) => (req.params as unknown as { id: number }).id;

export async function context(req: Request, res: Response): Promise<void> {
  const branchId = (req.query as unknown as { branch_id?: number }).branch_id ?? null;
  ok(res, await service.getContext(branchId));
}

export async function listTemplates(req: Request, res: Response): Promise<void> {
  ok(res, await service.listTemplates((req.query as { kind?: DocumentKind }).kind));
}

export async function getTemplate(req: Request, res: Response): Promise<void> {
  ok(res, await service.getTemplate(idParam(req)));
}

export async function createTemplate(req: Request, res: Response): Promise<void> {
  created(res, await service.createTemplate(actorOf(req), req.body as CreateTemplateBody));
}

export async function updateTemplate(req: Request, res: Response): Promise<void> {
  ok(res, await service.updateTemplate(actorOf(req), idParam(req), req.body as UpdateTemplateBody));
}

export async function setDefault(req: Request, res: Response): Promise<void> {
  ok(res, await service.setDefaultTemplate(actorOf(req), idParam(req)));
}

export async function deleteTemplate(req: Request, res: Response): Promise<void> {
  await service.deleteTemplate(actorOf(req), idParam(req));
  noContentOk(res);
}

export async function getProfile(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getProfile());
}

export async function updateProfile(req: Request, res: Response): Promise<void> {
  ok(res, await service.updateProfile(actorOf(req), req.body as ProfileBody));
}

export async function uploadLogo(req: Request, res: Response): Promise<void> {
  // `uploadImageFile` guarantees the file; the guard guarantees the actor.
  const file = req.file!;
  created(
    res,
    await mediaService.storePublicImage({
      bytes: file.buffer,
      originalFilename: file.originalname || null,
      uploadedByUserId: requireActorId(req),
    }),
  );
}

export async function labels(req: Request, res: Response): Promise<void> {
  ok(res, await service.labelData(req.body as LabelsBody));
}
