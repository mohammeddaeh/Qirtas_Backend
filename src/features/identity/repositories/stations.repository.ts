import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { sessionsTable } from '../../../core/auth/schemas/sessions.schema.js';
import { branchesTable } from '../schemas/branches.schema.js';
import { stationPolicyTable, stationsTable, type StationRow } from '../schemas/stations.schema.js';

export interface StationListRow extends StationRow {
  branch_name: string;
}

export async function findStations(branchId?: number): Promise<StationListRow[]> {
  const rows = await db
    .select({ s: stationsTable, branch_name: branchesTable.name })
    .from(stationsTable)
    .innerJoin(branchesTable, eq(branchesTable.id, stationsTable.branch_id))
    .where(branchId === undefined ? undefined : eq(stationsTable.branch_id, branchId))
    .orderBy(asc(stationsTable.branch_id), asc(stationsTable.name));
  return rows.map((r) => ({ ...r.s, branch_name: r.branch_name }));
}

export async function findLiveBranches(): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: branchesTable.id, name: branchesTable.name })
    .from(branchesTable)
    .where(isNull(branchesTable.archived_at))
    .orderBy(asc(branchesTable.id));
}

export async function findById(id: number): Promise<StationListRow | undefined> {
  const [row] = await db
    .select({ s: stationsTable, branch_name: branchesTable.name })
    .from(stationsTable)
    .innerJoin(branchesTable, eq(branchesTable.id, stationsTable.branch_id))
    .where(eq(stationsTable.id, id));
  return row ? { ...row.s, branch_name: row.branch_name } : undefined;
}

/** A live station by token hash — revoked rows never answer. */
export async function findLiveByTokenHash(tokenHash: string): Promise<StationListRow | undefined> {
  const [row] = await db
    .select({ s: stationsTable, branch_name: branchesTable.name })
    .from(stationsTable)
    .innerJoin(branchesTable, eq(branchesTable.id, stationsTable.branch_id))
    .where(and(eq(stationsTable.token_hash, tokenHash), isNull(stationsTable.revoked_at)));
  return row ? { ...row.s, branch_name: row.branch_name } : undefined;
}

export async function liveNameTaken(branchId: number, name: string): Promise<boolean> {
  const [row] = await db
    .select({ id: stationsTable.id })
    .from(stationsTable)
    .where(
      and(
        eq(stationsTable.branch_id, branchId),
        isNull(stationsTable.revoked_at),
        sql`lower(${stationsTable.name}) = lower(${name})`,
      ),
    );
  return row !== undefined;
}

export async function insertStation(values: typeof stationsTable.$inferInsert): Promise<StationRow> {
  const [row] = await db.insert(stationsTable).values(values).returning();
  return row!;
}

export async function touch(id: number, now: Date): Promise<void> {
  await db.update(stationsTable).set({ last_seen_at: now }).where(eq(stationsTable.id, id));
}

export async function markRevoked(id: number, by: number, now: Date): Promise<void> {
  await db.update(stationsTable).set({ revoked_at: now, revoked_by: by }).where(eq(stationsTable.id, id));
}

/** Ends every session opened at [stationId]; returns what the tombstones need. */
export async function deleteSessionsAt(stationId: number) {
  return db
    .delete(sessionsTable)
    .where(eq(sessionsTable.station_id, stationId))
    .returning({ token_hash: sessionsTable.token_hash, expires_at: sessionsTable.expires_at });
}

export async function setSessionStation(sessionId: number, stationId: number): Promise<void> {
  await db.update(sessionsTable).set({ station_id: stationId }).where(eq(sessionsTable.id, sessionId));
}

export async function readPolicy(): Promise<boolean> {
  const [row] = await db.select().from(stationPolicyTable).where(eq(stationPolicyTable.id, 1));
  return row?.enforce ?? false;
}

export async function writePolicy(enforce: boolean, by: number): Promise<void> {
  await db
    .insert(stationPolicyTable)
    .values({ id: 1, enforce, updated_by: by })
    .onConflictDoUpdate({
      target: stationPolicyTable.id,
      set: { enforce, updated_by: by, updated_at: new Date() },
    });
}
