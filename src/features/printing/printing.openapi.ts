import { z } from 'zod';
import { registry, successEnvelope, commonErrorResponses } from '../../core/openapi/registry.js';
import { idParamsSchema } from '../catalog/dtos/common.dto.js';
import {
  branchOptionsBodySchema,
  branchParamsSchema,
  branchQuerySchema,
  configQuerySchema,
  createOptionBodySchema,
  quoteBodySchema,
  ratesBodySchema,
  settingsBodySchema,
  tiersBodySchema,
  updateOptionBodySchema,
} from './dtos/printing.dto.js';
import {
  consumableParamsSchema,
  consumablesQuerySchema,
  installBodySchema,
  materialsQuerySchema,
  rulesBodySchema,
} from './dtos/consumption.dto.js';

/** إعداد الطباعة وتسعيرها بالوثائق المولَّدة — الأشكال كاملةً بـ`docs/rest_api.md` §29. */

const tags = ['Printing'];
const shape = z.object({}).passthrough();
const ok = (description: string) => ({
  description,
  content: { 'application/json': { schema: successEnvelope(shape) } },
});
const body = <T extends z.ZodTypeAny>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/printing/offer',
  tags,
  summary: 'What this branch prints — active options it has not disabled',
  description: 'Public. Grouped by kind, plus quantity tiers and file limits.',
  request: { query: branchQuerySchema },
  responses: { 200: ok('Offer'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/printing/quote',
  tags,
  summary: 'Price a print job at a branch',
  description:
    'Public. Branch rate first, then central, cell by cell. An unpriced cell is 409 `print_spec_unpriced` — never zero.',
  request: body(quoteBodySchema),
  responses: { 200: ok('Quote'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/printing/config',
  tags,
  summary: 'Options, central and branch prices, tiers, settings',
  description:
    'Requires `printing.settings` or `printing.branch_settings`. With `branch_id`, carries the branch overrides, the allowed band per cell and `can_edit_branch`.',
  request: { query: configQuerySchema },
  responses: { 200: ok('Config'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/printing/options',
  tags,
  summary: 'Add a spec option',
  description: 'Requires `printing.settings`. `code` is fixed once created.',
  request: body(createOptionBodySchema),
  responses: { 201: ok('Config'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/printing/options/{id}',
  tags,
  summary: 'Rename, reorder or deactivate an option',
  description: 'Requires `printing.settings`. No delete: a past job still names it.',
  request: { params: idParamsSchema, ...body(updateOptionBodySchema) },
  responses: { 200: ok('Config'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/printing/rates',
  tags,
  summary: 'Write central page and finishing rates',
  description:
    'Requires `printing.settings`. Only the cells sent are written; `amount_syp: null` removes a cell.',
  request: body(ratesBodySchema),
  responses: { 200: ok('Config'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/printing/tiers',
  tags,
  summary: 'Replace the quantity tiers',
  description: 'Requires `printing.settings`. On total printed pages; discounts the pages only.',
  request: body(tiersBodySchema),
  responses: { 200: ok('Config'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/printing/settings',
  tags,
  summary: 'Branch band, file retention, file and page limits',
  description: 'Requires `printing.settings`.',
  request: body(settingsBodySchema),
  responses: { 200: ok('Config'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/printing/branches/{branchId}/options',
  tags,
  summary: 'Enable or disable options at a branch',
  description: 'Requires `printing.branch_settings` at that branch. Absence means enabled.',
  request: { params: branchParamsSchema, ...body(branchOptionsBodySchema) },
  responses: { 200: ok('Config'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/printing/branches/{branchId}/rates',
  tags,
  summary: 'Branch price exceptions within the band',
  description:
    'Requires `printing.branch_settings` at that branch. Outside the band is 409 `print_rate_outside_band` with `min_syp`/`max_syp`; a cell with no central price is 409 `print_rate_no_central`.',
  request: { params: branchParamsSchema, ...body(ratesBodySchema) },
  responses: { 200: ok('Config'), ...commonErrorResponses },
});

// ── وصفة الاستهلاك (9-هـ، `rest_api.md` §31) ──
registry.registerPath({
  method: 'get',
  path: '/api/v1/printing/consumption-rules',
  tags,
  summary: 'What each print option consumes from branch stock',
  responses: { 200: ok('Rules'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/printing/consumption-rules',
  tags,
  summary: 'Replace the consumption recipe (central)',
  description:
    'Requires `printing.settings`. Each rule: option × material × basis, with a quantity OR a page yield (ink).',
  request: { ...body(rulesBodySchema) },
  responses: { 200: ok('Rules'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/printing/consumables',
  tags,
  summary: 'Yield-tracked materials at a branch, with what installing a new unit would reconcile',
  request: { query: consumablesQuerySchema },
  responses: { 200: ok('Consumables'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/printing/consumables/{variantId}/install',
  tags,
  summary: 'A new cartridge was installed — reconcile the estimate with reality',
  request: { params: consumableParamsSchema, ...body(installBodySchema) },
  responses: { 200: ok('Reconciliation'), ...commonErrorResponses },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/printing/materials',
  tags,
  summary: 'Catalog items usable as recipe materials, with their base unit',
  request: { query: materialsQuerySchema },
  responses: { 200: ok('Materials'), ...commonErrorResponses },
});
