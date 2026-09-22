import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import * as unitsRepository from '../repositories/units.repository.js';
import { CATALOG_AUDIT, catalogTarget } from '../audit-actions.js';
import {
  toWireUnit,
  type CreateUnitBody,
  type UpdateUnitBody,
  type WireUnit,
} from '../dtos/units.dto.js';

export async function listUnits(): Promise<WireUnit[]> {
  return (await unitsRepository.findAll()).map(toWireUnit);
}

async function assertNameIsFree(nameAr: string, exceptId?: number): Promise<void> {
  const wanted = normalizeArabic(nameAr);
  const clash = (await unitsRepository.findAll()).find(
    (row) => row.id !== exceptId && normalizeArabic(row.name_ar) === wanted,
  );
  if (clash) {
    throw new BusinessError(
      409,
      `A unit named "${clash.name_ar}" already exists`,
      'unit_name_taken',
    );
  }
}

export async function createUnit(
  actor: RequestActorContext,
  body: CreateUnitBody,
): Promise<WireUnit> {
  await assertNameIsFree(body.name_ar);
  const row = await unitsRepository.insert({
    name_ar: body.name_ar,
    name_en: body.name_en ?? null,
    allows_fraction: body.allows_fraction,
    ...(body.sort_order !== undefined ? { sort_order: body.sort_order } : {}),
  });
  await recordAudit(
    actor,
    CATALOG_AUDIT.unitCreate,
    catalogTarget.unit(row.id),
    null,
    toWireUnit(row),
  );
  return toWireUnit(row);
}

export async function updateUnit(
  actor: RequestActorContext,
  id: number,
  body: UpdateUnitBody,
): Promise<WireUnit> {
  const existing = await unitsRepository.findById(id);
  if (!existing) throw new NotFoundError('Unit not found');
  if (body.name_ar !== undefined) await assertNameIsFree(body.name_ar, id);

  const row = await unitsRepository.update(id, body);
  if (!row) throw new NotFoundError('Unit not found');
  await recordAudit(
    actor,
    CATALOG_AUDIT.unitUpdate,
    catalogTarget.unit(id),
    toWireUnit(existing),
    toWireUnit(row),
  );
  return toWireUnit(row);
}
