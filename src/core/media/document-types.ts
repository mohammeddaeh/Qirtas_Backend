import { fileTypeFromBuffer } from 'file-type';

/**
 * The file types a customer may hand us, decided by **the bytes**, never by the
 * name or the `Content-Type` the client sent — both are the client's word, and
 * `invoice.pdf` whose bytes are a Windows executable is exactly the file a
 * print-shop PC would open with a double click.
 */
export const DOCUMENT_TYPES = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  'jpg',
  'png',
  'webp',
  'heic',
  'txt',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Enough for every signature below, including the zip entry names of Office files. */
export const SNIFF_BYTES = 256 * 1024;

const MIME: Record<DocumentType, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  txt: 'text/plain; charset=utf-8',
};

export function mimeFor(type: DocumentType): string {
  return MIME[type];
}

/**
 * The extension of a client-supplied name, lower-cased — `null` when there is
 * none. Only used to **declare** intent at reservation (a friendly early
 * refusal) and to tell legacy Office formats apart; the verdict is `sniff`.
 */
export function declaredType(filename: string): DocumentType | null {
  const match = /\.([a-z0-9]{1,5})$/i.exec(filename.trim());
  if (!match) return null;
  const ext = match[1]!.toLowerCase();
  const normalised = ext === 'jpeg' ? 'jpg' : ext === 'heif' ? 'heic' : ext;
  return (DOCUMENT_TYPES as readonly string[]).includes(normalised)
    ? (normalised as DocumentType)
    : null;
}

/**
 * What the bytes are, among the allowed types — `null` for anything else.
 *
 * Two formats have no signature of their own and lean on the declared name:
 *
 * - **Legacy Office** (`.doc/.xls/.ppt`) are all one container (`cfb`), which
 *   an `.msi` installer also uses. Accepted only when the name says doc/xls/ppt,
 *   and served back **as that name** with `attachment` — so opening it starts
 *   Word, never the installer.
 * - **Text** has no magic number. Accepted when declared `.txt` and the head is
 *   valid UTF-8 without NUL bytes (a binary renamed `.txt` fails that).
 */
export async function sniff(
  head: Buffer,
  declared: DocumentType | null,
  allowed: readonly DocumentType[],
): Promise<DocumentType | null> {
  const detected = await fileTypeFromBuffer(head);
  let type: DocumentType | null = null;

  if (detected) {
    if (detected.ext === 'cfb') {
      type = declared === 'doc' || declared === 'xls' || declared === 'ppt' ? declared : null;
    } else if (detected.ext === 'jpg' || detected.ext === 'png' || detected.ext === 'webp') {
      type = detected.ext;
    } else if (detected.ext === 'heic') {
      type = 'heic';
    } else if (
      detected.ext === 'pdf' ||
      detected.ext === 'docx' ||
      detected.ext === 'xlsx' ||
      detected.ext === 'pptx'
    ) {
      type = detected.ext;
    }
  } else if (declared === 'txt' && looksLikeText(head)) {
    type = 'txt';
  }

  return type !== null && allowed.includes(type) ? type : null;
}

function looksLikeText(head: Buffer): boolean {
  if (head.length === 0 || head.includes(0)) return false;
  // A head cut mid-character is still text: drop up to 3 trailing bytes of an
  // incomplete UTF-8 sequence before the strict decode.
  for (let trim = 0; trim <= 3 && trim < head.length; trim++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - trim));
      return true;
    } catch {
      // try a shorter slice
    }
  }
  return false;
}
