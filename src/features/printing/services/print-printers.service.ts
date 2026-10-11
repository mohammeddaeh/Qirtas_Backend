import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import * as printingRepo from '../repositories/printing.repository.js';
import * as repo from '../repositories/print-printers.repository.js';
import type { PrintPrinterRow } from '../schemas/print-printers.schema.js';
import { BRANCH_SETTINGS_KEY, SETTINGS_KEY } from './printing.service.js';

/**
 * A branch's printers (9-ط-2, `printing_system.md`). Read by whoever sees the
 * queue there (the «ابدأ» sheet asks which one); set by the branch's printing
 * manager or the central one.
 */

const QUEUE_VIEW_KEY = 'printing.queue.view';

export interface WirePrinter {
  id: number;
  name: string;
  supports_color: boolean;
  is_active: boolean;
  sort_order: number;
  /** Never printed a job — so it may be deleted; otherwise it is stopped. */
  is_deletable: boolean;
}

export interface WirePrinters {
  branch_id: number;
  printers: WirePrinter[];
  /** Whether the reader may add, edit and remove — the screen follows this. */
  can_manage: boolean;
}

async function canManage(userId: number, branchId: number): Promise<boolean> {
  if (await holdsPermissionAt(userId, SETTINGS_KEY, null)) return true;
  return holdsPermissionAt(userId, BRANCH_SETTINGS_KEY, branchId);
}

async function requireManage(actor: RequestActorContext, branchId: number): Promise<void> {
  if (!(await canManage(actor.userId, branchId))) {
    throw new BusinessError(403, 'No printing permission at this branch', 'print_scope_denied', {
      branch_id: branchId,
    });
  }
}

async function wire(row: PrintPrinterRow): Promise<WirePrinter> {
  return {
    id: row.id,
    name: row.name,
    supports_color: row.supports_color,
    is_active: row.is_active,
    sort_order: row.sort_order,
    is_deletable: !(await repo.isUsed(row.id)),
  };
}

export async function listPrinters(actor: RequestActorContext, branchId: number): Promise<WirePrinters> {
  const [view, manage] = await Promise.all([
    holdsPermissionAt(actor.userId, QUEUE_VIEW_KEY, branchId),
    canManage(actor.userId, branchId),
  ]);
  if (!view && !manage) {
    throw new BusinessError(403, 'No printing permission at this branch', 'print_scope_denied', {
      branch_id: branchId,
    });
  }
  const rows = await repo.findByBranch(branchId);
  return { branch_id: branchId, printers: await Promise.all(rows.map(wire)), can_manage: manage };
}

function isNameTaken(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

function nameTaken(name: string): BusinessError {
  return new BusinessError(409, 'A printer with this name already exists at this branch', 'printer_name_taken', {
    name,
  });
}

export async function createPrinter(
  actor: RequestActorContext,
  body: { branch_id: number; name: string; supports_color?: boolean; sort_order?: number },
): Promise<WirePrinters> {
  await requireManage(actor, body.branch_id);
  if (!(await printingRepo.findLiveBranches()).some((b) => b.id === body.branch_id)) {
    throw new NotFoundError('Branch not found');
  }
  try {
    await repo.insert({
      branch_id: body.branch_id,
      name: body.name,
      supports_color: body.supports_color ?? true,
      sort_order: body.sort_order ?? 0,
    });
  } catch (error) {
    if (isNameTaken(error)) throw nameTaken(body.name);
    throw error;
  }
  return listPrinters(actor, body.branch_id);
}

async function requirePrinter(id: number): Promise<PrintPrinterRow> {
  const row = await repo.findById(id);
  if (!row) throw new NotFoundError('Printer not found');
  return row;
}

export async function updatePrinter(
  actor: RequestActorContext,
  id: number,
  patch: { name?: string; supports_color?: boolean; is_active?: boolean; sort_order?: number },
): Promise<WirePrinters> {
  const row = await requirePrinter(id);
  await requireManage(actor, row.branch_id);
  try {
    await repo.update(id, patch);
  } catch (error) {
    if (isNameTaken(error)) throw nameTaken(patch.name ?? row.name);
    throw error;
  }
  return listPrinters(actor, row.branch_id);
}

export async function deletePrinter(actor: RequestActorContext, id: number): Promise<WirePrinters> {
  const row = await requirePrinter(id);
  await requireManage(actor, row.branch_id);
  if (await repo.isUsed(id)) {
    throw new BusinessError(409, 'This printer printed orders — stop it instead', 'printer_in_use', { id });
  }
  await repo.remove(id);
  return listPrinters(actor, row.branch_id);
}

/**
 * The printer «ابدأ الطباعة» names — checked against the job (9-ط-2).
 *
 * **Optional** (user's decision 2026-10-08): the Windows station asks which
 * printer; a phone prints through its own system when the file opens, so it
 * starts without one. A named printer is still checked — another branch's,
 * a stopped one, or black-and-white for a colour job is refused.
 */
export async function resolveStartPrinter(
  branchId: number,
  colorCode: string | null,
  printerId: number | undefined,
): Promise<number | null> {
  if (printerId === undefined) return null;
  const active = await repo.findByBranch(branchId, true);
  const printer = active.find((p) => p.id === printerId);
  const needsColor = colorCode !== null && colorCode !== 'bw';
  if (!printer || (needsColor && !printer.supports_color)) {
    throw new BusinessError(422, 'This printer cannot print this order', 'printer_not_usable', {
      printer_id: printerId,
      needs_color: needsColor,
    });
  }
  return printer.id;
}
