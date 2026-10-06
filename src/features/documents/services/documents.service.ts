import type { ZodError } from 'zod';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { BusinessError, NotFoundError, ValidationError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { attachPublicImages, publicImagesByIds } from '../../../core/media/media.service.js';
import { resolvePricesAt } from '../../../core/pricing/price-port.js';
import * as repo from '../repositories/documents.repository.js';
import type { BusinessProfileRow, DocumentTemplateRow } from '../schemas/documents.schema.js';
import { DOCUMENTS_AUDIT, documentsTarget } from '../audit-actions.js';
import { layoutSchemaFor, type DocumentKind } from '../dtos/layout.schema.js';
import type {
  CreateTemplateBody,
  LabelsBody,
  ProfileBody,
  UpdateTemplateBody,
  WireDocumentContext,
  WireLabelItem,
  WireProfile,
  WireTemplate,
} from '../dtos/documents.dto.js';
import { pickLabelBarcode, pickLabelUnit } from './label-rules.js';

export const TEMPLATES_KEY = 'documents.templates';

function toWireTemplate(row: DocumentTemplateRow): WireTemplate {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    name: row.name,
    is_default: row.is_default,
    is_system: row.is_system,
    layout: row.layout,
    updated_at: row.updated_at.toISOString(),
  };
}

async function toWireProfile(row: BusinessProfileRow | undefined): Promise<WireProfile> {
  if (!row) {
    // A database migrated but not yet seeded: say nothing rather than fail every receipt.
    return {
      name_ar: '',
      name_en: null,
      logo: null,
      tax_number: null,
      commercial_register: null,
      updated_at: new Date(0).toISOString(),
    };
  }
  const logo =
    row.logo_media_id === null
      ? null
      : ((await publicImagesByIds([row.logo_media_id])).get(row.logo_media_id) ?? null);
  return {
    name_ar: row.name_ar,
    name_en: row.name_en,
    logo,
    tax_number: row.tax_number,
    commercial_register: row.commercial_register,
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Validates a layout for its kind and returns it **with every default filled**
 * — what is stored is exactly what every device reads back.
 *
 * A bad layout is a 422 naming the field under `layout.`, so the editor can
 * point at the block that is wrong instead of saying "invalid".
 */
function normaliseLayout(kind: DocumentKind, layout: unknown): Record<string, unknown> {
  const result = layoutSchemaFor(kind).safeParse(layout);
  if (!result.success) throw layoutError(result.error);
  return result.data as Record<string, unknown>;
}

function layoutError(error: ZodError): ValidationError {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = ['layout', ...issue.path].join('.');
    (details[field] ??= []).push(issue.message);
  }
  return new ValidationError(details);
}

async function templateOr404(id: number): Promise<DocumentTemplateRow> {
  const row = await repo.findTemplateById(id);
  if (!row) throw new NotFoundError('Template not found');
  return row;
}

/** A ready-made template is copied, never changed — it is the way back after an edit that went wrong. */
function assertNotSystem(row: DocumentTemplateRow): void {
  if (row.is_system) {
    throw new BusinessError(409, 'Ready-made templates are copied, not changed', 'document_template_is_system');
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function getContext(branchId: number | null): Promise<WireDocumentContext> {
  const [profile, branch, receipt, label, jobTag] = await Promise.all([
    repo.findProfile(),
    branchId === null ? Promise.resolve(undefined) : repo.findBranch(branchId),
    repo.findDefault('receipt'),
    repo.findDefault('label'),
    repo.findDefault('job_tag'),
  ]);
  if (branchId !== null && !branch) throw new NotFoundError('Branch not found');
  return {
    profile: await toWireProfile(profile),
    branch: branch ?? null,
    receipt_template: receipt ? toWireTemplate(receipt) : null,
    label_template: label ? toWireTemplate(label) : null,
    job_tag_template: jobTag ? toWireTemplate(jobTag) : null,
  };
}

export async function listTemplates(kind?: DocumentKind): Promise<WireTemplate[]> {
  return (await repo.findTemplates(kind)).map(toWireTemplate);
}

export async function getTemplate(id: number): Promise<WireTemplate> {
  return toWireTemplate(await templateOr404(id));
}

// ── Writes ─────────────────────────────────────────────────────────────────

export async function createTemplate(
  actor: RequestActorContext,
  body: CreateTemplateBody,
): Promise<WireTemplate> {
  let kind: DocumentKind;
  let layout: Record<string, unknown>;
  if (body.clone_from_id !== undefined) {
    const source = await repo.findTemplateById(body.clone_from_id);
    if (!source) throw new ValidationError({ clone_from_id: ['Unknown template'] });
    kind = source.kind;
    // Re-normalised: a copy of an old stored layout picks up any option added since.
    layout = normaliseLayout(kind, source.layout);
  } else {
    // The DTO guarantees both when there is no clone.
    kind = body.kind!;
    layout = normaliseLayout(kind, body.layout);
  }
  const row = await repo.insertTemplate({
    kind,
    name: body.name,
    layout,
    created_by: actor.userId,
    updated_by: actor.userId,
  });
  const wire = toWireTemplate(row);
  await recordAudit(actor, DOCUMENTS_AUDIT.templateCreate, documentsTarget.template(row.id), null, wire);
  return wire;
}

export async function updateTemplate(
  actor: RequestActorContext,
  id: number,
  body: UpdateTemplateBody,
): Promise<WireTemplate> {
  const existing = await templateOr404(id);
  assertNotSystem(existing);
  const row = await repo.updateTemplate(id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.layout !== undefined ? { layout: normaliseLayout(existing.kind, body.layout) } : {}),
    updated_by: actor.userId,
  });
  if (!row) throw new NotFoundError('Template not found');
  const wire = toWireTemplate(row);
  await recordAudit(
    actor,
    DOCUMENTS_AUDIT.templateUpdate,
    documentsTarget.template(id),
    toWireTemplate(existing),
    wire,
  );
  return wire;
}

/** Any template may become the default — a ready-made one too; choosing is not changing it. */
export async function setDefaultTemplate(actor: RequestActorContext, id: number): Promise<WireTemplate[]> {
  const row = await templateOr404(id);
  if (!row.is_default) {
    const previous = await repo.findDefault(row.kind);
    await repo.makeDefault(id, row.kind, actor.userId);
    await recordAudit(
      actor,
      DOCUMENTS_AUDIT.templateSetDefault,
      documentsTarget.template(id),
      previous ? { default_template_id: previous.id } : null,
      { default_template_id: id },
    );
  }
  // The whole kind comes back: the flag moved off another row, and patching one row shows two defaults.
  return listTemplates(row.kind);
}

export async function deleteTemplate(actor: RequestActorContext, id: number): Promise<void> {
  const row = await templateOr404(id);
  assertNotSystem(row);
  if (row.is_default) {
    // Every device prints with the default; deleting it leaves the till with nothing to print.
    throw new BusinessError(
      409,
      'Choose another default before deleting this template',
      'document_template_is_default',
    );
  }
  await repo.hardDeleteTemplate(id);
  await recordAudit(
    actor,
    DOCUMENTS_AUDIT.templateDelete,
    documentsTarget.template(id),
    toWireTemplate(row),
    null,
  );
}

export async function getProfile(): Promise<WireProfile> {
  return toWireProfile(await repo.findProfile());
}

export async function updateProfile(actor: RequestActorContext, body: ProfileBody): Promise<WireProfile> {
  const before = await repo.findProfile();
  if (body.logo_media_id !== null && body.logo_media_id !== before?.logo_media_id) {
    // Refuses an id that is not a public image, and marks it attached so the sweeper keeps it.
    await attachPublicImages('logo_media_id', [body.logo_media_id]);
  }
  const row = await repo.saveProfile({
    name_ar: body.name_ar,
    name_en: body.name_en ?? null,
    logo_media_id: body.logo_media_id,
    tax_number: body.tax_number ?? null,
    commercial_register: body.commercial_register ?? null,
    updated_by: actor.userId,
  });
  const wire = await toWireProfile(row);
  await recordAudit(
    actor,
    DOCUMENTS_AUDIT.profileUpdate,
    documentsTarget.profile(),
    before ? await toWireProfile(before) : null,
    wire,
  );
  return wire;
}

// ── Label data ─────────────────────────────────────────────────────────────

/**
 * What each label prints, in the order asked — **the price as the till charges
 * it at this branch**, through the catalog's own resolver (`core/pricing`).
 * A label with its own arithmetic is a second price rule, and the day it
 * disagrees the shelf says one number and the till charges another.
 */
/**
 * Where a label can be priced — the print sheet picks among them. Read here,
 * not from the branches or pricing module: whoever holds `barcodes.print`
 * holds neither of their keys.
 */
export function labelBranches(): Promise<{ id: number; name: string }[]> {
  return repo.findLabelBranches();
}

export async function labelData(body: LabelsBody): Promise<WireLabelItem[]> {
  const branch = await repo.findBranch(body.branch_id);
  if (!branch) throw new NotFoundError('Branch not found');

  const variantIds = [...new Set(body.items.map((i) => i.variant_id))];
  const [variants, labels, units, prices] = await Promise.all([
    repo.findVariants(variantIds),
    repo.findVariantLabels(variantIds),
    repo.findUnitsWithBarcodes(variantIds),
    resolvePricesAt(body.branch_id, variantIds, { promotions: 'apply', channel: 'pos', segment: 'retail' }),
  ]);
  const byId = new Map(variants.map((v) => [v.id, v]));

  const problems: Record<string, string[]> = {};
  const out: WireLabelItem[] = [];
  body.items.forEach((item, i) => {
    const variant = byId.get(item.variant_id);
    if (!variant) {
      problems[`items.${i}.variant_id`] = ['Unknown variant'];
      return;
    }
    const unit = pickLabelUnit(
      units.filter((u) => u.variant_id === item.variant_id),
      item.unit_id,
    );
    if (!unit) {
      problems[`items.${i}.unit_id`] = ['Not a unit of this variant'];
      return;
    }
    const factor = Number(unit.factor);
    const price = prices.get(item.variant_id);
    const priced = price?.status === 'priced' && price.amountSyp !== null;
    out.push({
      variant_id: variant.id,
      product_id: variant.product_id,
      unit_id: unit.unit_id,
      unit_name_ar: unit.name_ar,
      unit_factor: factor,
      name_ar: variant.name_ar,
      name_en: variant.name_en,
      variant_label_ar: labels.get(variant.id) ?? '',
      sku: variant.sku,
      barcode: pickLabelBarcode(unit.barcodes),
      price: {
        // No resolver answer reads as unpriced — never as a price of zero.
        status: price?.status ?? 'unpriced',
        amount_syp: priced ? Math.round(price.amountSyp! * factor) : null,
        was_syp: priced && price.promotion ? Math.round(price.promotion.beforeSyp * factor) : null,
        promotion_names: priced && price.promotion ? price.promotion.names : [],
      },
    });
  });
  if (Object.keys(problems).length > 0) throw new ValidationError(problems);
  return out;
}
