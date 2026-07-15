import type { Response } from 'express';

/**
 * The success envelope shape. `status` is ALWAYS a boolean (never the string
 * "success"/"error") — this matches the Flutter app's live /login parsing
 * code, which reads `status` as bool. See docs/rest_api.md.
 */
export interface SuccessEnvelope<T> {
  status: true;
  message: string;
  data: T;
}

export function ok<T>(res: Response, data: T, message = 'OK'): void {
  const body: SuccessEnvelope<T> = { status: true, message, data };
  res.status(200).json(body);
}

export function created<T>(res: Response, data: T, message = 'Created'): void {
  const body: SuccessEnvelope<T> = { status: true, message, data };
  res.status(201).json(body);
}

export function noContentOk(res: Response, message = 'OK'): void {
  const body: SuccessEnvelope<null> = { status: true, message, data: null };
  res.status(200).json(body);
}
