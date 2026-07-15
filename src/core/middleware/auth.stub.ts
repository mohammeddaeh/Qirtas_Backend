import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: { id: number } | null;
    }
  }
}

/**
 * PLACEHOLDER ONLY — no real authentication yet (see project plan: skeleton
 * scope explicitly excludes Auth). This reads the Bearer token if present
 * and attaches it to req, but never validates it and never blocks a request.
 *
 * When real auth is built, replace this with a middleware that verifies the
 * token and throws UnauthorizedError on failure — routes that already use
 * this stub won't need to change their shape, only this file's internals.
 */
export function authStub(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  // Intentionally not validated — placeholder only.
  req.user = token ? null : null;

  next();
}
