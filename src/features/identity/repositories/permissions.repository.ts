import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import {
  permissionsTable,
  type PermissionRow,
  type NewPermissionRow,
} from '../schemas/permissions.schema.js';

export async function findAll(): Promise<PermissionRow[]> {
  return db.select().from(permissionsTable);
}

export async function findByKey(key: string): Promise<PermissionRow | undefined> {
  const rows = await db
    .select()
    .from(permissionsTable)
    .where(eq(permissionsTable.key, key))
    .limit(1);
  return rows[0];
}

export async function findByKeys(keys: string[]): Promise<PermissionRow[]> {
  if (keys.length === 0) return [];
  return db.select().from(permissionsTable).where(inArray(permissionsTable.key, keys));
}

export async function insert(data: NewPermissionRow): Promise<PermissionRow> {
  const rows = await db.insert(permissionsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}
