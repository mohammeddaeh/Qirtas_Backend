import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_LANG, isSupportedLang, type Lang } from '../i18n/messages.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      lang: Lang;
    }
  }
}

/**
 * Reads the Accept-language header the Flutter app sends on every request
 * (see auth_interceptor.dart) and normalizes it to req.lang. Defaults to
 * DEFAULT_LANG ('ar') for missing/unsupported values. Validated against
 * SUPPORTED_LANGUAGES (see core/i18n/messages.ts) — adding a language there
 * is the only change needed here.
 */
export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('Accept-language') ?? req.header('Accept-Language');
  const code = header?.toLowerCase().split('-')[0];
  req.lang = isSupportedLang(code) ? code : DEFAULT_LANG;
  next();
}
