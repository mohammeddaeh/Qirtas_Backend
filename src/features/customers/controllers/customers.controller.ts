import type { Request, Response } from 'express';
import { ok, created } from '../../../core/http/response.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { toPaginationParams } from '../../../core/pagination/pagination.js';
import { requireCustomerId } from '../../../core/http/require-customer.js';
import type { RequestOrigin } from '../../../core/auth/services/auth.service.js';
import * as customersService from '../services/customers.service.js';
import { applyContactPolicy } from '../dtos/customers.dto.js';
import { registerPermission } from '../../../core/authz/registry.js';
import * as assignmentsRepository from '../../identity/repositories/user-role-assignments.repository.js';
import type {
  CustomersFilterQuery,
  DecideWholesaleBody,
  DeleteMeBody,
  RegisterCustomerBody,
  UpdateCustomerProfileBody,
} from '../dtos/customers.dto.js';

function originOf(req: Request): RequestOrigin {
  return {
    ipAddress: req.ip ?? null,
    deviceInfo: req.header('User-Agent') ?? null,
    lang: req.lang,
  };
}

export async function register(req: Request, res: Response): Promise<void> {
  const body = req.body as RegisterCustomerBody;
  const result = await customersService.register(body, originOf(req));
  created(
    res,
    result,
    result.customer.email_verified
      ? 'Registration complete'
      : 'Registration complete — confirm your email address to place orders',
  );
}

export async function getMe(req: Request, res: Response): Promise<void> {
  ok(res, await customersService.getMe(requireCustomerId(req)));
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateCustomerProfileBody;
  ok(res, await customersService.updateMe(requireCustomerId(req), body, originOf(req)));
}

export async function deleteMe(req: Request, res: Response): Promise<void> {
  const { password } = req.body as DeleteMeBody;
  await customersService.deleteSelf(requireCustomerId(req), password, originOf(req));
  ok(res, null, 'Account deleted');
}

// ── Admin side ────────────────────────────────────────────────────────────────

export async function listCustomers(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { page: number; limit: number } & CustomersFilterQuery;
  ok(
    res,
    await customersService.listCustomers(
      toPaginationParams(query),
      query,
      await canSeeContact(req),
    ),
  );
}

export async function getCustomerById(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  ok(res, applyContactPolicy(await customersService.getCustomerById(id), await canSeeContact(req)));
}

/**
 * Declared here because no ROUTE guards it: the check is data-dependent (the same
 * endpoint answers everyone, with contact details masked for those without the
 * key), so `requirePermission` — which refuses — is the wrong shape. Registering
 * it is what makes the catalogue and the role grants know it exists; without this
 * the seed treats the key as a plan for an unbuilt module and never creates it.
 */
const CONTACT_PERMISSION = registerPermission('customers.contact', {
  display: { ar: 'عرض بيانات تواصل الزبائن', en: 'View Customer Contact Details' },
});

/**
 * Whether this employee may read customers' email and phone (`customers.contact`).
 * Read from the same effective-permission union the guards use, so an override
 * granting or revoking it applies here too.
 */
async function canSeeContact(req: Request): Promise<boolean> {
  const keys = await assignmentsRepository.findAllEffectivePermissionKeys(requireActorId(req));
  return keys.includes(CONTACT_PERMISSION);
}

function staffActor(req: Request) {
  return buildActorContext(req, requireActorId(req));
}

export async function suspendCustomer(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  ok(res, await customersService.suspendCustomer(staffActor(req), id));
}

export async function disableCustomer(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  ok(res, await customersService.disableCustomer(staffActor(req), id));
}

export async function reactivateCustomer(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  ok(res, await customersService.reactivateCustomer(staffActor(req), id));
}

export async function requestWholesale(req: Request, res: Response): Promise<void> {
  ok(res, await customersService.requestWholesale(requireCustomerId(req), originOf(req)));
}

export async function decideWholesale(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  ok(
    res,
    await customersService.decideWholesale(staffActor(req), id, req.body as DecideWholesaleBody),
  );
}

export async function archiveCustomer(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  ok(res, await customersService.archiveCustomer(staffActor(req), id));
}

export async function unarchiveCustomer(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  ok(res, await customersService.unarchiveCustomer(staffActor(req), id));
}

export async function deleteCustomer(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  await customersService.deleteCustomer(staffActor(req), id);
  ok(res, null, 'Customer deleted');
}

export async function resendVerification(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  await customersService.resendVerification(staffActor(req), id, originOf(req));
  ok(res, null, 'Verification code sent');
}

export async function sendPasswordReset(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  await customersService.sendPasswordReset(staffActor(req), id, originOf(req));
  ok(res, null, 'Password reset code sent');
}

export async function listActivity(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as { id: number };
  const query = req.query as unknown as { page: number; limit: number };
  ok(res, await customersService.listActivity(id, toPaginationParams(query)));
}
