import {
  registry,
  successEnvelope,
  errorEnvelope,
  commonErrorResponses,
  unauthorizedResponse,
} from '../../core/openapi/registry.js';
import { dashboardStatsResponseSchema } from './dtos/dashboard-stats.dto.js';

const tags = ['Dashboard'];

registry.registerPath({
  method: 'get',
  path: '/api/v1/dashboard',
  tags,
  summary: "Aggregate stats for the admin dashboard, scoped to the caller's own permissions",
  description:
    'Requires dashboard.view. Each top-level block (users/branches/roles/charts/structure/signals) is ' +
    'present only if the caller also holds the matching module permission (users.manage / ' +
    'branches.manage / roles.view) — mirrors visibility of the list screen each stat card links to. ' +
    '`structure` spans both axes of the branch × role relation and so requires users.manage AND ' +
    'branches.manage together. Inside it, `people` (distinct users) and `assignments` (assignment rows) ' +
    'legitimately differ — one person may hold several roles or work across branches — and must be ' +
    'labelled distinctly by any client. A branch with no active assignment is present with people = 0 ' +
    'and roles = []; an absent (branch, role) pair is a real coverage gap, not missing data. Signals ' +
    'carry a machine `code` plus raw numbers only — never localisable prose.',
  responses: {
    200: {
      description: 'Dashboard stats, with only the permitted blocks present',
      content: { 'application/json': { schema: successEnvelope(dashboardStatsResponseSchema) } },
    },
    ...unauthorizedResponse,
    403: {
      description: 'Missing dashboard.view permission',
      content: { 'application/json': { schema: errorEnvelope } },
    },
    ...commonErrorResponses,
  },
});
