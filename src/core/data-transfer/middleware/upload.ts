import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { extname } from 'node:path';
import { PayloadTooLargeError, ValidationError } from '../../http/api-error.js';
import type { TransferFormat } from '../types.js';

/**
 * The single multipart entry point in this API.
 *
 * Every constraint below is a refusal that has to exist somewhere, and nowhere
 * later is early enough:
 *
 * - **Memory storage, not disk.** Nothing is written to the filesystem, so
 *   there is no temp file to clean up, no path to traverse, and no partially
 *   uploaded artefact left behind by a dropped connection. Affordable only
 *   because of the byte limit below.
 * - **5 MB, one file, one field.** An import endpoint without a byte cap is a
 *   memory-exhaustion primitive handed to every signed-in user. 5 MB is far
 *   above the 10 000-row cap the service enforces and far below anything that
 *   threatens the process.
 * - **Extension allow-list.** Not a security control on its own — the parsers
 *   are what actually decide — but it turns "I picked the wrong file" into a
 *   clear 422 instead of an unintelligible parse failure.
 */

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    // Without this, a request can carry thousands of tiny text fields that
    // never trip `fileSize` — the limit that looks like it covers the request
    // covers only the file part of it.
    fields: 10,
    parts: 12,
  },
});

const EXTENSION_FORMATS: Record<string, TransferFormat> = {
  '.csv': 'csv',
  '.xlsx': 'xlsx',
};

/**
 * `upload.single('file')` with multer's own errors translated into this API's
 * envelope.
 *
 * Left untranslated, a file over the limit reaches the client as multer's
 * `MulterError` through the generic error handler — a 500 with an opaque
 * message for what is squarely a 413 the user can act on.
 */
export function uploadTransferFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(
          new PayloadTooLargeError('The file is larger than 5 MB', {
            max_bytes: MAX_UPLOAD_BYTES,
          }),
        );
        return;
      }
      next(new ValidationError({ file: [error.message] }));
      return;
    }
    if (error) {
      next(error);
      return;
    }
    next();
  });
}

/**
 * Resolves the upload's format from its filename.
 *
 * From the **extension**, not the browser-supplied MIME type: clients send
 * `application/octet-stream` for `.xlsx` about as often as the correct type,
 * and Windows sends `application/vnd.ms-excel` for `.csv`. Trusting either
 * produces a refusal the user cannot explain, on a file that is perfectly
 * valid.
 */
export function requireUploadedFile(req: Request): {
  file: { buffer: Buffer; originalname: string };
  format: TransferFormat;
} {
  const file = req.file;
  if (!file) {
    throw new ValidationError({ file: ['No file was uploaded'] });
  }

  const format = EXTENSION_FORMATS[extname(file.originalname).toLowerCase()];
  if (!format) {
    throw new ValidationError({
      file: [`Unsupported file type — expected ${Object.keys(EXTENSION_FORMATS).join(' or ')}`],
    });
  }

  return { file: { buffer: file.buffer, originalname: file.originalname }, format };
}
