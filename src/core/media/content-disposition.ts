/**
 * `attachment` so a browser saves instead of rendering, with the original name
 * in RFC 5987 form (Arabic names survive) and an ASCII fallback for old clients.
 *
 * Used by both drivers' download paths (the S3 presigned GET and the local
 * `GET /files/private/*`) so a file is labelled the same way wherever it lives.
 */
export function contentDisposition(filename: string | null): string {
  if (!filename) return 'attachment';
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
