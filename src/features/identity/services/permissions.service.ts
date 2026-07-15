import { BusinessError } from '../../../core/http/api-error.js';
import * as permissionsRepository from '../repositories/permissions.repository.js';
import {
  toWirePermission,
  type WirePermission,
  type CreatePermissionBody,
} from '../dtos/permissions.dto.js';

export async function listPermissions(): Promise<WirePermission[]> {
  const rows = await permissionsRepository.findAll();
  return rows.map(toWirePermission);
}

export async function createPermission(body: CreatePermissionBody): Promise<WirePermission> {
  const existing = await permissionsRepository.findByKey(body.key);
  if (existing) {
    throw new BusinessError(409, `Permission "${body.key}" already exists`);
  }
  const row = await permissionsRepository.insert({
    key: body.key,
    module: body.module,
    is_sensitive: body.is_sensitive,
  });
  return toWirePermission(row);
}

/** Throws if any of the given keys don't exist in the catalog — used by role creation/update. */
export async function assertPermissionKeysExist(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const found = await permissionsRepository.findByKeys(keys);
  const foundKeys = new Set(found.map((p) => p.key));
  const missing = keys.filter((k) => !foundKeys.has(k));
  if (missing.length > 0) {
    throw new BusinessError(422, `Unknown permission key(s): ${missing.join(', ')}`);
  }
}

export async function isAnySensitive(keys: string[]): Promise<boolean> {
  if (keys.length === 0) return false;
  const found = await permissionsRepository.findByKeys(keys);
  return found.some((p) => p.is_sensitive);
}
