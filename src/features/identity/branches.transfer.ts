import { z } from 'zod';
import { ForbiddenError } from '../../core/http/api-error.js';
import { defineTransferResource } from '../../core/data-transfer/registry.js';
import type {
  TransferAction,
  TransferContext,
  TransferFilters,
  TransferRow,
} from '../../core/data-transfer/types.js';
import { createBranchBodySchema, type CreateBranchBody } from './dtos/branches.dto.js';
import * as branchesRepository from './repositories/branches.repository.js';
import * as userRoleAssignmentsRepository from './repositories/user-role-assignments.repository.js';

/**
 * Branches as an import/export resource.
 *
 * The whole cost of making a feature transferable: this file, plus one line in
 * `app.ts`. No controller, no route, no DTO, and no Flutter — the client builds
 * its column picker, format choice, import template and error table from
 * `GET /api/v1/data-transfer/resources` at runtime.
 *
 * ## `authorize` is not optional here, and the reason generalises
 *
 * `POST /api/v1/branches` is guarded by `requirePermission('branches.manage')`.
 * The generic transfer routes carry only `requireAuth` — they cannot know what
 * any particular resource considers privileged. Without the guard below, **any
 * signed-in user could create branches by uploading a spreadsheet**: not a
 * weaker form of the permission, but a complete bypass of it reached through a
 * different URL.
 *
 * Reading is deliberately *not* guarded, because `GET /api/v1/branches` is not
 * either — the guard mirrors the feature's own routes rather than inventing a
 * policy of its own. Any resource whose rows are not scoped to the caller needs
 * this same mirroring.
 */

const branchesTransferFiltersSchema = z.object({
  /** Same free-text contract as `GET /branches?search=` — name or address. */
  search: z.string().trim().max(150).optional(),
});

async function requirePermission(userId: number, key: string): Promise<void> {
  const keys = await userRoleAssignmentsRepository.findAllEffectivePermissionKeys(userId);
  if (!keys.includes(key)) {
    throw new ForbiddenError(`Missing required permission: ${key}`, undefined, 'permission_missing');
  }
}

export const branchesTransferResource = defineTransferResource({
  name: 'branches',
  label: { ar: 'الفروع', en: 'Branches' },

  columns: [
    {
      key: 'id',
      label: { ar: 'المعرّف', en: 'ID' },
      type: 'number',
      // Server-assigned. Exportable so a row traces back to the app; never
      // importable, or a file could name the primary key of an existing branch.
      importable: false,
      hint: { ar: 'رقم تُنشئه المنظومة — لا يُملأ', en: 'Assigned by the system' },
    },
    {
      key: 'name',
      label: { ar: 'اسم الفرع', en: 'Branch name' },
      type: 'string',
      required: true,
      // `example` is a VALUE and lands in the template file, where its job is
      // to show the shape. `hint` is a MEANING and appears in the app beside
      // the name. They were one field, so the screen showed a sample branch
      // where an explanation belonged.
      example: 'فرع الكورنيش',
      hint: {
        ar: 'إلزامي · اسم مميّز لا يتكرر مع فرع آخر',
        en: 'Required · must not repeat another branch',
      },
    },
    {
      key: 'address',
      label: { ar: 'العنوان', en: 'Address' },
      type: 'string',
      example: 'شارع الكورنيش، اللاذقية',
      hint: { ar: 'اختياري · موقع الفرع', en: 'Optional · where the branch is' },
    },
    {
      key: 'contact_info',
      label: { ar: 'رقم التواصل', en: 'Contact number' },
      type: 'string',
      // Validated by the same Syrian-phone schema `POST /branches` uses — see
      // `rowSchema` below. A second, looser copy here would let an import store
      // numbers the API itself refuses.
      example: '0912345678',
      hint: {
        ar: 'اختياري · عشرة أرقام تبدأ بـ09',
        en: 'Optional · ten digits starting 09',
      },
    },
    {
      key: 'status',
      label: { ar: 'الحالة', en: 'Status' },
      type: 'string',
      // Exportable, not importable: a new branch is `active` by table default,
      // and closing one is a decision made on a screen, not in a spreadsheet.
      importable: false,
      hint: { ar: 'تُضبط من شاشة الفرع', en: 'Set from the branch screen' },
    },
    {
      key: 'is_default',
      label: { ar: 'الفرع الافتراضي', en: 'Default branch' },
      type: 'boolean',
      // Never importable. A file that could set this would silently move the
      // organisation's default branch — an organisational act, not data entry.
      importable: false,
      hint: { ar: 'قرار تنظيمي لا يُستورَد', en: 'An organisational decision' },
    },
    {
      key: 'created_at',
      label: { ar: 'تاريخ الإنشاء', en: 'Created at' },
      type: 'datetime',
      importable: false,
      hint: { ar: 'تُسجّله المنظومة', en: 'Recorded by the system' },
    },
  ],

  filtersSchema: branchesTransferFiltersSchema,

  /**
   * What the export screen draws — **and the key it sends.**
   *
   * `search`, matching `branchesTransferFiltersSchema` above and
   * `GET /branches?search=`. The client used to hardcode `q`, so this filter
   * sent a parameter the schema ignored: a text box that looked like it worked,
   * filtered nothing, and reported no error. These two declarations sit two
   * lines apart precisely so a rename cannot touch one without the other.
   */
  filters: [
    {
      key: 'search',
      label: { ar: 'بحث', en: 'Search' },
      type: 'text',
      placeholder: { ar: 'اسم الفرع أو عنوانه', en: 'Branch name or address' },
    },
  ],

  async authorize(ctx: TransferContext, action: TransferAction) {
    // Mirrors the feature's own routes exactly: reading is open to any signed-in
    // caller, writing is not.
    if (action === 'import') await requirePermission(ctx.userId, 'branches.manage');
  },

  countRows(_ctx: TransferContext, filters: TransferFilters) {
    return branchesRepository.countForExport(filters['search'] as string | undefined);
  },

  async *readRows(
    _ctx: TransferContext,
    filters: TransferFilters,
  ): AsyncGenerator<TransferRow> {
    for await (const row of branchesRepository.iterateForExport(
      filters['search'] as string | undefined,
    )) {
      // A real `Date`, not a formatted string. The engine writes ISO into CSV
      // and a typed date cell into XLSX; pre-formatting here would produce a
      // spreadsheet whose dates are text and do not sort.
      yield {
        id: row.id,
        name: row.name,
        address: row.address,
        contact_info: row.contact_info,
        status: row.status,
        is_default: row.is_default,
        created_at: row.created_at,
      };
    }
  },

  import: {
    /** **The same schema `POST /api/v1/branches` validates against** — not a copy. */
    rowSchema: createBranchBodySchema,

    /**
     * A branch is identified by its name.
     *
     * Turning this on catches the two duplicate mistakes that actually happen:
     * the same name twice **inside one file** (a block pasted twice, or an
     * export appended to and re-imported), and a name that **already exists**.
     * Both are reported against the cell, so the user sees which row to delete
     * rather than being told a count.
     */
    uniqueBy: ['name'],

    /**
     * `error`, not `skip`.
     *
     * Branch names are entered by people and a repeat is nearly always a
     * mistake worth seeing — a silently skipped row leaves the user believing
     * they imported something they did not. Change this to `skip` for a
     * resource where re-uploading last month's file should be a no-op.
     */
    onDuplicate: 'error',

    findExisting(_ctx: TransferContext, keys: string[]) {
      return branchesRepository.findExistingNames(keys);
    },

    commit(_ctx: TransferContext, rows: unknown[]) {
      return branchesRepository.insertManyFromImport(rows as CreateBranchBody[]);
    },
  },
});
