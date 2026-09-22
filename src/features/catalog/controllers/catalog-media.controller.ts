import type { Request, Response } from 'express';
import { created } from '../../../core/http/response.js';
import { requireActorId } from '../../../core/http/require-actor.js';
import * as mediaService from '../../../core/media/media.service.js';

export async function uploadImage(req: Request, res: Response): Promise<void> {
  // `uploadImageFile` guarantees the file; the guard guarantees the actor.
  const file = req.file!;
  const image = await mediaService.storePublicImage({
    bytes: file.buffer,
    originalFilename: file.originalname || null,
    uploadedByUserId: requireActorId(req),
  });
  created(res, image);
}
