import type { Request, Response } from 'express';
import { ok } from '../../http/response.js';
import { requireActorId } from '../../http/require-actor.js';
import { ApiError, ValidationError } from '../../http/api-error.js';
import { getTransferResource, listTransferResources } from '../registry.js';
import type { TransferAction, TransferResource } from '../types.js';
import { toWireResource } from '../descriptor.js';
import { planExport } from '../services/export.service.js';
import { planTemplate } from '../services/template.service.js';
import {
  commitImport,
  validateEditedRows,
  validateImport,
} from '../services/import.service.js';
import { requireUploadedFile } from '../middleware/upload.js';

/**
 * `GET /api/v1/data-transfer/resources` — the descriptor the Flutter module
 * builds its entire UI from.
 *
 * **Filtered per caller**, not merely listed. A resource whose `authorize`
 * refuses this actor is dropped; one they may export but not import comes back
 * with `supports_import: false` and an empty `import_formats`.
 *
 * Two reasons, and the second is the one that matters. The obvious one is that
 * offering a button which answers 403 is a bad screen. The real one is that
 * this payload carries every column name of every resource — so an unfiltered
 * listing hands the schema of things like a staff roster to anyone signed in,
 * through an endpoint nobody thinks of as sensitive.
 *
 * Cost: one `authorize` call per resource per request, each of which may hit
 * the database in an RBAC application. That is fine for the handful of
 * resources an application declares, and worth watching if that ever becomes
 * dozens.
 */
export async function listResources(req: Request, res: Response): Promise<void> {
  const userId = requireActorId(req);
  const ctx = { userId };

  const visible = await Promise.all(
    listTransferResources().map(async (resource) => {
      if (!(await allowed(resource, ctx, 'export'))) return null;

      const wire = toWireResource(resource);
      if (wire.supports_import && !(await allowed(resource, ctx, 'import'))) {
        return { ...wire, supports_import: false, import_formats: [] };
      }
      return wire;
    }),
  );

  ok(res, { resources: visible.filter((r) => r !== null) });
}

/**
 * Runs a resource's guard and reports the verdict as a boolean.
 *
 * Only the *refusal* is swallowed. Anything else — a database error inside a
 * permission lookup — is rethrown, because treating an infrastructure failure
 * as "not permitted" would quietly empty this list and look like a
 * configuration problem for as long as the outage lasted.
 */
async function allowed(
  resource: TransferResource,
  ctx: { userId: number },
  action: TransferAction,
): Promise<boolean> {
  if (!resource.authorize) return true;
  try {
    await resource.authorize(ctx, action);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.httpStatus === 403) return false;
    throw error;
  }
}

/**
 * `GET /api/v1/data-transfer/:resource/export` — **the one endpoint in this API
 * that does not answer the success envelope.**
 *
 * It answers file bytes. That exception is deliberate and it is also a trap
 * with history: the Flutter side's `HandleBodyResponse` parses every response
 * as JSON, so pointing the ordinary repository path at this route produces
 * "something went wrong" on a 200 with a perfectly good CSV attached — the same
 * class of silent wire defect that once broke sign-in for weeks. The client
 * module downloads this route through `dio.download` with `ResponseType.bytes`
 * and never touches `handle()`. See `readme/integration_audit.md`.
 *
 * Failures still answer the envelope, and they all happen **before** the first
 * byte is written (see `export.service.ts`) — so a client that reads the status
 * line knows which of the two shapes is coming.
 */
export async function exportResource(req: Request, res: Response): Promise<void> {
  const userId = requireActorId(req);
  const { resource: resourceName } = req.params as unknown as { resource: string };

  const resource = getTransferResource(resourceName);
  await resource.authorize?.({ userId }, 'export');

  const plan = await planExport(resource, { userId }, req.query);

  res.status(200);
  res.setHeader('Content-Type', plan.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${plan.filename}"`);
  // Lets a browser or a Dart client read the name off a cross-origin response;
  // without it `fetch`/`dio` see the header stripped and fall back to the URL,
  // which ends in `/export`.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Row-Count');
  res.setHeader('X-Row-Count', String(plan.rowCount));
  // The row cap makes an export bounded, not small. Nothing downstream should
  // cache a per-user file keyed only by URL.
  res.setHeader('Cache-Control', 'no-store');

  await plan.write(res);
}

/**
 * `GET /api/v1/data-transfer/:resource/template` — an empty file shaped the way
 * the importer expects. Answers bytes, with the same caveat as `export`.
 */
export async function downloadTemplate(req: Request, res: Response): Promise<void> {
  const userId = requireActorId(req);
  const { resource: resourceName } = req.params as unknown as { resource: string };

  const resource = getTransferResource(resourceName);
  // Guarded as an **import** action, because that is what it is for. A template
  // also leaks the column list of a resource the caller may not import.
  await resource.authorize?.({ userId }, 'import');

  const plan = await planTemplate(resource, req.query);

  res.status(200);
  res.setHeader('Content-Type', plan.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${plan.filename}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Cache-Control', 'no-store');

  await plan.write(res);
}

/**
 * `POST /api/v1/data-transfer/:resource/import` — both phases, selected by
 * `?mode=`.
 *
 * One route rather than two because they are one operation from the client's
 * side, and splitting them invites a caller to reach the second without the
 * first. `mode=validate` takes a multipart file and answers a report;
 * `mode=commit` takes the token that report carried and answers counts.
 *
 * Both answer the ordinary success envelope — unlike `export`, there is no
 * binary in either direction here.
 */
export async function importResource(req: Request, res: Response): Promise<void> {
  const userId = requireActorId(req);
  const { resource: resourceName } = req.params as unknown as { resource: string };
  const mode = (req.query['mode'] as string | undefined) ?? 'validate';

  const resource = getTransferResource(resourceName);
  // Before either phase. Checking only at commit would still let an
  // unauthorised caller upload a file and read back a validation report of a
  // resource they cannot touch — which is an oracle for its schema.
  await resource.authorize?.({ userId }, 'import');

  if (mode === 'validate') {
    // Two bodies, one phase. A multipart body is the first upload; a JSON body
    // is the same file after the user fixed cells in the app's grid. Both run
    // the identical rules — a separate "re-validate" endpoint would be a second
    // copy of them, and the copies would drift until the grid accepted rows the
    // upload refused.
    const body = req.body as { columns?: unknown; rows?: unknown } | undefined;

    if (Array.isArray(body?.rows)) {
      if (!Array.isArray(body.columns) || !body.columns.every((c) => typeof c === 'string')) {
        throw new ValidationError({ columns: ['`columns` must be an array of column keys'] });
      }
      if (!body.rows.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) {
        throw new ValidationError({ rows: ['`rows` must be an array of objects'] });
      }
      ok(
        res,
        await validateEditedRows(
          resource,
          { userId },
          body.columns as string[],
          body.rows as Array<Record<string, unknown>>,
        ),
      );
      return;
    }

    const { file, format } = requireUploadedFile(req);
    ok(res, await validateImport(resource, { userId }, file, format));
    return;
  }

  if (mode === 'commit') {
    // Read from the body, which multer has already parsed — the same request
    // shape carries the token whether the client sends multipart or JSON.
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || token.trim() === '') {
      throw new ValidationError({ token: ['A validate token is required'] });
    }
    ok(res, await commitImport(resource, { userId }, token.trim()));
    return;
  }

  throw new ValidationError({ mode: ['Expected "validate" or "commit"'] });
}
