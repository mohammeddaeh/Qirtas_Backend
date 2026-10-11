import type { Lang } from '../i18n/messages.js';

/**
 * Work arriving for whoever does it — **not** a decision about the reader's
 * own account (that is `events.ts`). A print order sent from the app, an order
 * paid and now printable, an order allowed to print before payment.
 *
 * Push only, never email: the work is live, and a mail per order is noise in
 * an inbox nobody reads at the printer (9-ط-1, 2026-10-07).
 */
export const WORK_NOTIFICATION = {
  printJobSubmitted: 'print_job_submitted',
  printJobPrintable: 'print_job_printable',
} as const;

export type WorkNotificationEvent = (typeof WORK_NOTIFICATION)[keyof typeof WORK_NOTIFICATION];

export interface WorkNotificationParams {
  /** Who it is for — the account's name or the name typed at the counter. */
  customer?: string | null | undefined;
  /** The order number, or the print's name when it has one. */
  what?: string | null | undefined;
  /** Allowed before payment (deferred) rather than paid. */
  deferred?: boolean | undefined;
}

interface Text {
  title: string;
  body: string;
}

const line = (...parts: (string | null | undefined)[]): string => parts.filter((p) => p && p.trim()).join(' · ');

const TEXT: Record<WorkNotificationEvent, Record<Lang, (p: WorkNotificationParams) => Text>> = {
  print_job_submitted: {
    ar: (p) => ({ title: 'طلب طباعة جديد', body: line(p.customer, p.what) || 'بانتظار التسعير' }),
    en: (p) => ({ title: 'New print order', body: line(p.customer, p.what) || 'Waiting to be priced' }),
  },
  print_job_printable: {
    ar: (p) => ({
      title: p.deferred ? 'سُمح بالطباعة قبل الدفع' : 'دُفع طلب — جاهز للطباعة',
      body: line(p.what, p.customer),
    }),
    en: (p) => ({
      title: p.deferred ? 'Allowed to print before payment' : 'Order paid — ready to print',
      body: line(p.what, p.customer),
    }),
  },
};

export function workNotificationText(event: WorkNotificationEvent, lang: Lang, params: WorkNotificationParams): Text {
  return TEXT[event][lang](params);
}
