import type { Request, Response } from 'express';
import type { ErrorEnvelope } from './error-handler.js';

/** Mounted after all routers — anything unmatched becomes a 404 error envelope. */
export function notFound(req: Request, res: Response): void {
  const body: ErrorEnvelope = {
    status: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    code: 404,
  };
  res.status(404).json(body);
}
