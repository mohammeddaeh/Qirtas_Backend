import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import { paginated, type Paginated, type PaginationParams } from '../../../core/pagination/pagination.js';
import { INVENTORY_AUDIT, inventoryTarget } from '../audit-actions.js';
import {
  toWireSupplier,
  type CreateSupplierBody,
  type SuppliersFilterQuery,
  type UpdateSupplierBody,
  type WireSupplier,
} from '../dtos/suppliers.dto.js';
import * as suppliersRepository from '../repositories/suppliers.repository.js';
import type { SupplierRow } from '../schemas/suppliers.schema.js';

/**
 * Suppliers — one shared record per trader (inventory_suppliers.md §٧).
 *
 * Removal follows the same two exits as every other record (rest_api.md §16):
 * **delete** what never appeared on an invoice, **archive** what did — an old
 * purchase invoice must keep naming the man who delivered it.
 */

async function wire(row: SupplierRow): Promise<WireSupplier> {
  return toWireSupplier(row, await suppliersRepository.countInvoices(row.id));
}

export async function listSuppliers(
  params: PaginationParams,
  filter: SuppliersFilterQuery,
): Promise<Paginated<WireSupplier>> {
  const { rows, total } = await suppliersRepository.findMany(params, {
    search: filter.search ? normalizeArabic(filter.search) : undefined,
    archived: filter.archived === true,
  });
  // The counts are per row; a shop has tens of suppliers, not thousands.
  const wired = await Promise.all(rows.map(wire));
  return paginated(wired, total, params);
}

async function require_(id: number): Promise<SupplierRow> {
  const row = await suppliersRepository.findById(id);
  if (!row) throw new NotFoundError('Supplier not found');
  return row;
}

export async function getSupplier(id: number): Promise<WireSupplier> {
  return wire(await require_(id));
}

/**
 * Two suppliers with the same name (folded) are one supplier typed twice, and
 * the second one splits his invoices into a history nobody can add up.
 */
async function assertNameIsFree(searchText: string, exceptId?: number): Promise<void> {
  const clash = await suppliersRepository.findBySearchText(searchText);
  if (!clash || clash.id === exceptId) return;
  throw new BusinessError(409, `A supplier named "${clash.name}" already exists`, 'supplier_name_taken');
}

export async function createSupplier(actor: RequestActorContext, body: CreateSupplierBody): Promise<WireSupplier> {
  const searchText = normalizeArabic(body.name);
  await assertNameIsFree(searchText);
  const row = await suppliersRepository.insert({
    name: body.name,
    search_text: searchText,
    phone: body.phone ?? null,
    email: body.email ?? null,
    address: body.address ?? null,
    notes: body.notes ?? null,
    ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
    created_by_user_id: actor.userId,
  });
  await recordAudit(actor, INVENTORY_AUDIT.supplierCreate, inventoryTarget.supplier(row.id), null, {
    name: row.name,
  });
  return wire(row);
}

function assertNotArchived(row: SupplierRow): void {
  if (row.archived_at === null) return;
  throw new BusinessError(409, 'This supplier is archived', 'supplier_archived');
}

export async function updateSupplier(
  actor: RequestActorContext,
  id: number,
  body: UpdateSupplierBody,
): Promise<WireSupplier> {
  const before = await require_(id);
  assertNotArchived(before);
  const searchText = body.name === undefined ? undefined : normalizeArabic(body.name);
  if (searchText !== undefined) await assertNameIsFree(searchText, id);
  const row = await suppliersRepository.update(id, {
    ...(body.name !== undefined ? { name: body.name, search_text: searchText } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.address !== undefined ? { address: body.address } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
  });
  await recordAudit(
    actor,
    INVENTORY_AUDIT.supplierUpdate,
    inventoryTarget.supplier(id),
    { name: before.name, is_active: before.is_active },
    { name: row?.name, is_active: row?.is_active },
  );
  return wire(row!);
}

export async function setSupplierArchived(
  actor: RequestActorContext,
  id: number,
  archived: boolean,
): Promise<WireSupplier> {
  const before = await require_(id);
  const row = await suppliersRepository.update(id, {
    archived_at: archived ? new Date() : null,
    // Archiving switches the supplier off as well: a record that is hidden
    // everywhere but still "active" is a contradiction a picker cannot show.
    ...(archived ? { is_active: false } : {}),
  });
  await recordAudit(
    actor,
    archived ? INVENTORY_AUDIT.supplierArchive : INVENTORY_AUDIT.supplierUnarchive,
    inventoryTarget.supplier(id),
    { archived_at: before.archived_at },
    { archived_at: row?.archived_at },
  );
  return wire(row!);
}

/** Only what never appeared on an invoice; everything else archives. */
export async function deleteSupplier(actor: RequestActorContext, id: number): Promise<void> {
  const row = await require_(id);
  const invoices = await suppliersRepository.countInvoices(id);
  if (invoices > 0)
    throw new BusinessError(409, 'This supplier has purchase invoices — archive instead', 'supplier_has_invoices', {
      invoices_count: invoices,
    });
  await suppliersRepository.hardDelete(id);
  await recordAudit(actor, INVENTORY_AUDIT.supplierDelete, inventoryTarget.supplier(id), { name: row.name }, null);
}
