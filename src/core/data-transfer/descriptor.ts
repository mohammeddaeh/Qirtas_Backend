import type { TransferResource } from './types.js';

/**
 * Turns registered resources into the payload of
 * `GET /api/v1/data-transfer/resources`.
 *
 * **This is the contract that makes the client generic.** The Flutter module
 * has no per-feature code at all: it renders a column picker, a format picker,
 * **its filter controls** and an error table from this descriptor, so adding an
 * exportable feature is zero lines of Dart. That only holds while every field a
 * client needs is present here — anything the UI has to hardcode instead is a
 * bug in this file, and `filters` was added because the export screen was
 * hardcoding a `?q=` box that the first real application's schema ignored.
 *
 * Keys are snake_case, matching every other response and
 * `app_template/test/fixtures/wire/`.
 */

export interface WireLabel {
  ar: string;
  en: string;
}

export interface WireTransferColumn {
  key: string;
  label: WireLabel;
  type: string;
  required: boolean;
  importable: boolean;
  /** A sample value — what the template's example row contains. Teaches the format. */
  example?: string;
  /** One line on what the column means. Shown beside the name in the app; never written to a file. */
  hint?: WireLabel;
}

export interface WireTransferFilter {
  key: string;
  label: WireLabel;
  type: string;
  placeholder?: WireLabel;
  options?: Array<{ value: string; label: WireLabel }>;
}

export interface WireTransferResource {
  name: string;
  label: WireLabel;
  export_formats: string[];
  import_formats: string[];
  max_export_rows: number;
  /** `false` when the resource declares no import spec — the client hides the import entry entirely rather than offering an action that 404s. */
  supports_import: boolean;
  columns: WireTransferColumn[];
  /** Filter controls the export screen should render. Empty = no filters. */
  filters: WireTransferFilter[];
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
      // Omitted rather than sent as null when absent: the Dart model treats
      // absent and null alike, but a null would render as the string "null" in
      // a template if anyone ever forgot.
      ...(c.example !== undefined ? { example: c.example } : {}),
      ...(c.hint !== undefined ? { hint: c.hint } : {}),
    })),
    filters: (resource.filters ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {}),
      ...(f.options !== undefined ? { options: f.options } : {}),
    })),
  };
}
