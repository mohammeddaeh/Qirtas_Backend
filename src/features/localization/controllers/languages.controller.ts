import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import * as languagesService from '../services/languages.service.js';
import type { CreateLanguageBody, UpdateLanguageBody } from '../dtos/languages.dto.js';
import type { ReplaceTranslationsBody } from '../dtos/translations.dto.js';

export async function listLanguages(_req: Request, res: Response): Promise<void> {
  const result = await languagesService.listActiveLanguages();
  ok(res, result);
}

export async function getLanguageByCode(req: Request, res: Response): Promise<void> {
  const { code } = req.params as unknown as { code: string };
  const language = await languagesService.getLanguageByCode(code);
  ok(res, language);
}

export async function createLanguage(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateLanguageBody;
  const language = await languagesService.createLanguage(body);
  created(res, language);
}

export async function updateLanguage(req: Request, res: Response): Promise<void> {
  const { code } = req.params as unknown as { code: string };
  const body = req.body as UpdateLanguageBody;
  const language = await languagesService.updateLanguage(code, body);
  ok(res, language);
}

export async function deactivateLanguage(req: Request, res: Response): Promise<void> {
  const { code } = req.params as unknown as { code: string };
  const language = await languagesService.deactivateLanguage(code);
  ok(res, language);
}

export async function getTranslations(req: Request, res: Response): Promise<void> {
  const { code } = req.params as unknown as { code: string };
  const translations = await languagesService.getActiveTranslations(code);
  ok(res, translations);
}

export async function replaceTranslations(req: Request, res: Response): Promise<void> {
  const { code } = req.params as unknown as { code: string };
  const body = req.body as ReplaceTranslationsBody;
  const language = await languagesService.replaceTranslations(code, body.translations);
  ok(res, language);
}
