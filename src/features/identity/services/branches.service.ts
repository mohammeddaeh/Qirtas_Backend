import { NotFoundError } from '../../../core/http/api-error.js';
import {
  paginated,
  type PaginationParams,
  type Paginated,
} from '../../../core/pagination/pagination.js';
import * as branchesRepository from '../repositories/branches.repository.js';
import {
  toWireBranch,
  type WireBranch,
  type CreateBranchBody,
  type UpdateBranchBody,
} from '../dtos/branches.dto.js';

export async function listBranches(params: PaginationParams): Promise<Paginated<WireBranch>> {
  const { rows, total } = await branchesRepository.findMany(params);
  return paginated(rows.map(toWireBranch), total, params);
}

export async function getBranchById(id: number): Promise<WireBranch> {
  const row = await branchesRepository.findById(id);
  if (!row) throw new NotFoundError('Branch not found');
  return toWireBranch(row);
}

export async function createBranch(body: CreateBranchBody): Promise<WireBranch> {
  const row = await branchesRepository.insert({
    name: body.name,
    address: body.address,
    contact_info: body.contact_info,
  });
  return toWireBranch(row);
}

export async function updateBranch(id: number, body: UpdateBranchBody): Promise<WireBranch> {
  const existing = await branchesRepository.findById(id);
  if (!existing) throw new NotFoundError('Branch not found');

  const row = await branchesRepository.update(id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.address !== undefined ? { address: body.address } : {}),
    ...(body.contact_info !== undefined ? { contact_info: body.contact_info } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
  });
  if (!row) throw new NotFoundError('Branch not found');
  return toWireBranch(row);
}
