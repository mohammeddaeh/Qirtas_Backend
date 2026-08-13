import type { TransferResource } from './types.js';

/**
 * Turns registered resources into the payload of
 * `GET /api/v1/data-transfer/resources`.
 *
 * **This is the contract that makes the client generic.** The Flutter module
 * has no per-feature code at all: it renders a column picker, a format picker
 * and an error table from this descriptor, so adding an exportable feature is
 * zero lines of Dart. That only holds while every field a client needs is
 * present here — anything the UI has to hardcode instead is a bug in this file.
 *
 * Keys are snake_case, matching every other response and
 * `app_template/test/fixtures/wire/`.
 */

export interface WireTransferColumn {
  key: string;
  label: { ar: string; en: string };
  type: string;
  required: boolean;
  importable: boolean;
  example?: string;
}

export interface WireTransferResource {
  name: string;
  label: { ar: string; en: string };
  export_formats: string[];
  import_formats: string[];
  max_export_rows: number;
  /** `false` when the resource declares no import spec — the client hides the import entry entirely rather than offering an action that 404s. */
  supports_import: boolean;
  columns: WireTransferColumn[];
}

export function toWireResource(resource: TransferResource): WireTransferResource {
  return {
    name: resource.name,
    label: resource.label,
    export_formats: resource.exportFormats,
    import_formats: resource.importFormats,
    max_export_rows: resource.maxExportRows,
    supports_import: resource.import !== undefined,
    columns: resource.columns.map((c) => ({
      key: c.key,
      label: c.label,
      type: c.type,
      required: c.required,
      importable: c.importable,
      ...(c.example !== undefined ? { example: c.example } : {}),
    })),
  };
}
