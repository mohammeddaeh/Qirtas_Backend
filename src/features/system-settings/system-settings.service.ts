import { asc, isNull } from 'drizzle-orm';
import { recordAudit } from '../../core/audit/audit-recorder.js';
import { db } from '../../core/db/client.js';
import { BusinessError } from '../../core/http/api-error.js';
import type { RequestActorContext } from '../../core/http/require-actor.js';
import {
  DEFAULT_FORMATS,
  DOC_TYPES,
  formatProblem,
  peekNumber,
  readFormats,
  saveFormat,
  type DocType,
  type NumberingFormat,
} from '../../core/numbering/numbering.js';
import { branchPrefix } from '../../core/records/branch-prefix.js';
import { branchesTable } from '../identity/schemas/branches.schema.js';

/**
 * System settings (`docs/reference/system_settings.md`) — central rules that
 * apply to every branch. Today: document numbering (step 2).
 */

export interface WireNumberingFormat extends NumberingFormat {
  doc_type: DocType;
  /** Still the shape the type had before numbering was a setting. */
  is_default: boolean;
  /** The next number for [WireNumbering.sample_branch_code] — issues nothing. */
  next: string;
}

export interface WireNumbering {
  sample_branch_code: string;
  formats: WireNumberingFormat[];
  /** Every live branch's code — the codes that start the numbers. */
  branches: { id: number; name: string; code: string }[];
}

async function liveBranches(): Promise<{ id: number; name: string; code: string }[]> {
  return db
    .select({ id: branchesTable.id, name: branchesTable.name, code: branchesTable.code })
    .from(branchesTable)
    .where(isNull(branchesTable.archived_at))
    .orderBy(asc(branchesTable.id));
}

export async function getNumbering(): Promise<WireNumbering> {
  const [formats, branches] = await Promise.all([readFormats(), liveBranches()]);
  const sample = branches[0] ? branchPrefix(branches[0].code, branches[0].id) : 'MZ';
  const rows = await Promise.all(
    DOC_TYPES.map(async (type) => {
      const f = formats[type];
      const d = DEFAULT_FORMATS[type];
      return {
        doc_type: type,
        ...f,
        is_default: f.prefix === d.prefix && f.date_format === d.date_format && f.digits === d.digits,
        next: await peekNumber(f, sample, new Date(), type),
      };
    }),
  );
  return { sample_branch_code: sample, formats: rows, branches };
}

/** What a draft would print — refused drafts say why, before anything is saved. */
export async function previewNumbering(
  docType: DocType,
  draft: NumberingFormat,
  branchCode: string,
): Promise<{ next: string; length: number; problem: string | null }> {
  const formats = await readFormats();
  const next = await peekNumber(draft, branchCode, new Date(), docType);
  return { next, length: next.length, problem: formatProblem(docType, draft, formats) };
}

export async function setNumbering(
  actor: RequestActorContext,
  docType: DocType,
  draft: NumberingFormat,
): Promise<WireNumbering> {
  const formats = await readFormats();
  const problem = formatProblem(docType, draft, formats);
  if (problem) refuse(problem);
  await saveFormat(docType, draft, actor.userId);
  await recordAudit(actor, 'system_settings.numbering.set', `numbering:${docType}`, formats[docType], draft);
  return getNumbering();
}

/** One literal throw per rule — the message-key check reads them. */
function refuse(problem: string): never {
  switch (problem) {
    case 'numbering_prefix_invalid':
      throw new BusinessError(422, 'A prefix is up to 4 Latin capitals', 'numbering_prefix_invalid');
    case 'numbering_digits_invalid':
      throw new BusinessError(422, 'Digits must be between 3 and 8', 'numbering_digits_invalid');
    case 'numbering_prefix_taken':
      throw new BusinessError(409, 'Another document type already uses this prefix', 'numbering_prefix_taken');
    default:
      throw new BusinessError(422, 'This number would be too long to print', 'numbering_too_long');
  }
}
