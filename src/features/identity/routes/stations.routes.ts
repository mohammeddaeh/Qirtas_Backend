import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { buildActorContext, requireActorId } from '../../../core/http/require-actor.js';
import { requirePermission } from '../../../core/http/require-permission.js';
import { ok } from '../../../core/http/response.js';
import { publicRoute } from '../../../core/http/route-marker.js';
import { validate } from '../../../core/validation/validate.js';
import * as stations from '../services/stations.service.js';

/**
 * Registered computers — `docs/reference/stations.md`, `rest_api.md` §محطات الحاسوب.
 */
export const stationsRouter = Router();

const canManage = requirePermission('stations.manage', {
  display: { ar: 'إدارة محطات الحاسوب', en: 'Manage Computer Stations' },
  // Pairing a computer lets staff sign in from it — and revoking ends their sessions.
  sensitive: true,
});

const listQuerySchema = z.object({ branch_id: z.coerce.number().int().positive().optional() }).strict();
const registerBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(stations.STATION_KINDS),
    device_info: z.string().max(300).optional(),
  })
  .strict();
const policyBodySchema = z.object({ enforce: z.boolean() }).strict();
const idParams = z.object({ id: z.coerce.number().int().positive() });

const tokenOf = (req: Request) => req.header('X-Station-Token') ?? undefined;

stationsRouter.get(
  '/',
  canManage,
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;
    ok(res, await stations.listStations(q.branch_id));
  }),
);

// The computer the administrator is sitting at — registered from inside.
stationsRouter.post(
  '/register-here',
  canManage,
  validate(registerBodySchema, 'body'),
  asyncHandler(async (req, res) => {
    const actor = buildActorContext(req, requireActorId(req));
    ok(res, await stations.registerHere(actor, req.body as z.infer<typeof registerBodySchema>));
  }),
);

stationsRouter.put(
  '/policy',
  canManage,
  validate(policyBodySchema, 'body'),
  asyncHandler(async (req, res) => {
    const actor = buildActorContext(req, requireActorId(req));
    ok(res, await stations.setEnforcement(actor, (req.body as { enforce: boolean }).enforce));
  }),
);

stationsRouter.post(
  '/:id/revoke',
  canManage,
  validate(idParams, 'params'),
  asyncHandler(async (req, res) => {
    const actor = buildActorContext(req, requireActorId(req));
    ok(res, await stations.revokeStation(actor, (req.params as unknown as { id: number }).id));
  }),
);

// The station a token names — the client shows «الصندوق ١ · فرع …» and opens
// the till on its branch. Public: the token is the credential.
stationsRouter.get(
  '/current',
  publicRoute,
  asyncHandler(async (req, res) => {
    ok(res, await stations.currentStation(tokenOf(req)));
  }),
);
