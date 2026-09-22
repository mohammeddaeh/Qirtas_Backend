import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { requireCustomerId } from '../../../core/http/require-customer.js';
import type { RequestOrigin } from '../../../core/auth/services/auth.service.js';
import * as addressesService from '../services/customer-addresses.service.js';
import type { CreateAddressBody, UpdateAddressBody } from '../dtos/customer-addresses.dto.js';

function originOf(req: Request): RequestOrigin {
  return {
    ipAddress: req.ip ?? null,
    deviceInfo: req.header('User-Agent') ?? null,
    lang: req.lang,
  };
}

function addressIdOf(req: Request): number {
  return (req.params as unknown as { addressId: number }).addressId;
}

export async function list(req: Request, res: Response): Promise<void> {
  ok(res, await addressesService.list(requireCustomerId(req)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateAddressBody;
  created(res, await addressesService.create(requireCustomerId(req), body, originOf(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateAddressBody;
  ok(
    res,
    await addressesService.update(requireCustomerId(req), addressIdOf(req), body, originOf(req)),
  );
}

export async function makeDefault(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await addressesService.makeDefault(requireCustomerId(req), addressIdOf(req), originOf(req)),
  );
}

export async function remove(req: Request, res: Response): Promise<void> {
  ok(res, await addressesService.remove(requireCustomerId(req), addressIdOf(req), originOf(req)));
}
