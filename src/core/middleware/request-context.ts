import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      lang: 'ar' | 'en';
    }
  }
}

/**
 * Reads the Accept-language header the Flutter app sends on every request
 * (see auth_interceptor.dart) and normalizes it to req.lang. Defaults to
 * 'ar' since that's this app's primary locale.
 */
export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('Accept-language') ?? req.header('Accept-Language');
  req.lang = header?.toLowerCase().startsWith('en') ? 'en' : 'ar';
  next();
}
