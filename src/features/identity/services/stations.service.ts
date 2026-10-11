import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { generateSessionToken, hashToken } from '../../../core/auth/services/token.service.js';
import * as tombstonesRepository from '../../../core/auth/repositories/session-tombstones.repository.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { staffAuthRealm } from '../auth-realm.js';
import * as branchesRepository from '../repositories/branches.repository.js';
import * as repo from '../repositories/stations.repository.js';
import type { StationListRow } from '../repositories/stations.repository.js';

/**
 * **Registered computers** (`docs/reference/stations.md`, phase 2).
 *
 * The administration pairs a computer with a one-time code; the computer keeps
 * a station token and sends it with every request. Staff sign-in from a
 * computer then knows which station it is — and, when the policy says so,
 * refuses a computer the shop never registered.
 */

/** What a computer is for — and so who signs in on it (user decision 2026-10-11). */
export const STATION_KINDS = ['till', 'printing', 'office'] as const;
export type StationKind = (typeof STATION_KINDS)[number];

/**
 * The permission a kind asks of whoever signs in on it — by permission, never
 * by role name: a role the administration creates tomorrow fits a till the
 * moment it can sell.
 */
export const KIND_PERMISSION: Record<StationKind, string> = {
  till: 'sales.sell',
  printing: 'printing.queue.view',
  office: 'dashboard.view',
};

export function kindOf(value: string): StationKind {
  return (STATION_KINDS as readonly string[]).includes(value) ? (value as StationKind) : 'till';
}

export interface WireStation {
  id: number;
  name: string;
  kind: StationKind;
  branch: { id: number; name: string };
  registered_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  device_info: string | null;
}

function wire(s: StationListRow): WireStation {
  return {
    id: s.id,
    name: s.name,
    kind: kindOf(s.kind),
    branch: { id: s.branch_id, name: s.branch_name },
    registered_at: s.registered_at,
    last_seen_at: s.last_seen_at,
    revoked_at: s.revoked_at,
    device_info: s.device_info,
  };
}

export async function listStations(
  branchId?: number,
): Promise<{ enforce: boolean; items: WireStation[]; branches: { id: number; name: string }[] }> {
  const [enforce, rows, branches] = await Promise.all([
    repo.readPolicy(),
    repo.findStations(branchId),
    repo.findLiveBranches(),
  ]);
  return { enforce, items: rows.map(wire), branches };
}

/**
 * **Registers the computer the administrator is sitting at** (user decision
 * 2026-10-11): no code to carry from one screen to another — whoever holds
 * `stations.manage` signs in on the computer and registers it from inside. The
 * answer carries the station token, which the client keeps in secure storage.
 */
export async function registerHere(
  actor: RequestActorContext,
  body: { branch_id: number; name: string; kind: StationKind; device_info?: string | undefined },
): Promise<{ station: WireStation; token: string }> {
  const branch = await branchesRepository.findById(body.branch_id);
  if (!branch || branch.archived_at) throw new NotFoundError('Branch not found');
  const name = body.name.trim();
  if (await repo.liveNameTaken(body.branch_id, name)) {
    throw new BusinessError(409, 'A live station in this branch already has that name', 'station_name_taken');
  }
  const token = generateSessionToken();
  const row = await repo.insertStation({
    branch_id: body.branch_id,
    name,
    kind: body.kind,
    token_hash: hashToken(token),
    registered_by: actor.userId,
    device_info: body.device_info?.slice(0, 300) ?? null,
    last_seen_at: new Date(),
  });
  await recordAudit(actor, 'station.register', `station:${row.id}`, null, { name, kind: body.kind, branch_id: body.branch_id });
  const station = await repo.findById(row.id);
  return { station: wire(station!), token };
}

/** The live station a token names, or `null` — refreshes `last_seen_at` once a minute. */
export async function resolveStation(token: string | undefined): Promise<StationListRow | null> {
  if (!token) return null;
  const station = await repo.findLiveByTokenHash(hashToken(token));
  if (!station) return null;
  const now = new Date();
  if (!station.last_seen_at || now.getTime() - station.last_seen_at.getTime() > 60_000) {
    await repo.touch(station.id, now);
  }
  return station;
}

export async function currentStation(token: string | undefined): Promise<WireStation> {
  const station = await resolveStation(token);
  if (!station) throw new BusinessError(404, 'Not a registered station', 'station_not_registered');
  return wire(station);
}

/** Revoking ends every session opened at the station — the computer is out, now. */
export async function revokeStation(actor: RequestActorContext, id: number): Promise<WireStation> {
  const station = await repo.findById(id);
  if (!station) throw new NotFoundError('Station not found');
  if (!station.revoked_at) {
    const now = new Date();
    await repo.markRevoked(id, actor.userId, now);
    const ended = await repo.deleteSessionsAt(id);
    await tombstonesRepository.insertMany(
      staffAuthRealm,
      ended.map((r) => ({ tokenHash: r.token_hash, expiresAt: r.expires_at })),
      'station_revoked',
    );
    await recordAudit(actor, 'station.revoke', `station:${id}`, { revoked_at: null }, { revoked_at: now });
  }
  return wire((await repo.findById(id))!);
}

export async function setEnforcement(actor: RequestActorContext, enforce: boolean): Promise<{ enforce: boolean }> {
  const before = await repo.readPolicy();
  await repo.writePolicy(enforce, actor.userId);
  await recordAudit(actor, 'station.policy', 'station_policy', { enforce: before }, { enforce });
  return { enforce };
}

export const readEnforcement = repo.readPolicy;
export const bindSessionToStation = repo.setSessionStation;
