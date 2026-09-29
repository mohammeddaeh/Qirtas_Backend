/**
 * Audited document actions. Same `<entity>.<verb>` convention and the same
 * `audit_log_entries` table as every other module, written through
 * `core/audit/audit-recorder.ts`.
 */
export const DOCUMENTS_AUDIT = {
  profileUpdate: 'documents.profile.update',
  templateCreate: 'documents.template.create',
  templateUpdate: 'documents.template.update',
  templateDelete: 'documents.template.delete',
  templateSetDefault: 'documents.template.set_default',
} as const;

/** `target_entity` values — what `EntityHistorySection(targetEntity:)` filters by. */
export const documentsTarget = {
  profile: () => 'business_profile:1',
  template: (id: number) => `document_template:${id}`,
} as const;
