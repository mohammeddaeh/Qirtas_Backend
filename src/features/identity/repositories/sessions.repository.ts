import { db } from '../../../core/db/client.js';
import { sessionsTable, type SessionRow, type NewSessionRow } from '../schemas/sessions.schema.js';

export async function insert(data: NewSessionRow): Promise<SessionRow> {
  const rows = await db.insert(sessionsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}
