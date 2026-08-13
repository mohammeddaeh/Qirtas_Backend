import { NotFoundError } from '../http/api-error.js';
import {
  DEFAULT_MAX_EXPORT_ROWS,
  type TransferFormat,
  type TransferResource,
  type TransferResourceDefinition,
} from './types.js';

/**
 * The one map from resource name to its declaration.
 *
 * Features register into it the same way they register OpenAPI paths — a
 * side-effect import collected in one file (`resources.ts`), so "which
 * resources exist" is answerable by reading a single list rather than by
 * grepping for a decorator.
 *
 * Nothing outside this module mutates the map: `getTransferResource` and
 * `listTransferResources` are the whole read surface, and both hand back
 * definitions with every optional already resolved so no consumer has to
 * re-apply a default (and no two consumers can apply different ones).
 */

const resources = new Map<string, TransferResource>();

const DEFAULT_EXPORT_FORMATS: TransferFormat[] = ['csv', 'xlsx'];

/**
 * Resolves the optional half of a [TransferResourceDefinition] and validates
 * what a compiler cannot.
 *
 * Call it at module scope in the feature's `*.transfer.ts` and export the
 * result; `resources.ts` registers it. The checks below throw **at boot**, not
 * on the first request: a resource whose import spec references a column that
 * does not exist would otherwise produce a template with a header nothing can
 * fill, and be discovered by a user.
 */
export function defineTransferResource(def: TransferResourceDefinition): TransferResource {
  if (def.columns.length === 0) {
    throw new Error(`Transfer resource "${def.name}" declares no columns`);
  }

  const seen = new Set<string>();
  for (const column of def.columns) {
    if (seen.has(column.key)) {
      // Two columns with one key produce a file whose header repeats, and an
      // import that silently keeps whichever came last.
      throw new Error(`Transfer resource "${def.name}" declares column "${column.key}" twice`);
    }
    seen.add(column.key);
  }

  const columns = def.columns.map((c) => ({
    ...c,
    importable: c.importable ?? true,
    required: c.required ?? false,
  }));

  const importFormats = def.import ? (def.importFormats ?? DEFAULT_EXPORT_FORMATS) : [];

  if (def.import && !columns.some((c) => c.importable)) {
    throw new Error(
      `Transfer resource "${def.name}" declares an import spec but no importable column`,
    );
  }

  return {
    ...def,
    columns,
    exportFormats: def.exportFormats ?? DEFAULT_EXPORT_FORMATS,
    importFormats,
    maxExportRows: def.maxExportRows ?? DEFAULT_MAX_EXPORT_ROWS,
  };
}

export function registerTransferResource(resource: TransferResource): void {
  if (resources.has(resource.name)) {
    throw new Error(`Transfer resource "${resource.name}" is already registered`);
  }
  resources.set(resource.name, resource);
}

/**
 * Throws [NotFoundError] for an unknown name — the same 404 an unknown id gets,
 * and deliberately not a 400. Which resources exist is already public to any
 * signed-in caller via `GET /resources`; what matters is that the failure is
 * the ordinary one clients already handle.
 */
export function getTransferResource(name: string): TransferResource {
  const resource = resources.get(name);
  if (!resource) throw new NotFoundError(`Unknown data-transfer resource "${name}"`);
  return resource;
}

export function listTransferResources(): TransferResource[] {
  return [...resources.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test-only. Registration is boot-time and one-way in a running process. */
export function clearTransferResources(): void {
  resources.clear();
}
