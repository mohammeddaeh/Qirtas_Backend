import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { PayloadTooLargeError, ValidationError } from '../../http/api-error.js';

/**
 * Multipart intake for one image, field `file`.
 *
 * Memory storage for the same reasons as `core/data-transfer/middleware/upload.ts`:
 * no temp file, no path, nothing half-written left by a dropped connection —
 * affordable only because of the byte cap. 10 MB covers any phone photo; the
 * app compresses before sending, so real uploads are far smaller.
 *
 * No extension or MIME allow-list here: the decoder in `image-processing.ts`
 * reads the actual bytes and is the only judge that cannot be lied to.
 */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES, files: 1, fields: 5, parts: 6 },
});

export function uploadImageFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(
          new PayloadTooLargeError(
            'The image is larger than 10 MB',
            { max_bytes: MAX_IMAGE_UPLOAD_BYTES },
            'image_too_large',
          ),
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
    if (!req.file) {
      next(new ValidationError({ file: ['No file was uploaded'] }));
      return;
    }
    next();
  });
}
