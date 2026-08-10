import { pool, db } from './client.js';
import { rolesTable } from '../../features/identity/schemas/roles.schema.js';

const rows = await db.select().from(rolesTable);
for (const r of rows) {
  if (r.id === 2 || r.id === 25) {
    console.log(r.id, JSON.stringify(r.name), '| codepoints:', [...r.name].map(c => c.codePointAt(0)!.toString(16)).join(' '), '| active:', r.is_active);
  }
}
await pool.end();
