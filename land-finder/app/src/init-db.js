import { pool, ensureSchema } from './db.js';
const db = await pool();
try {
  await ensureSchema(db);
  console.log('DB schema ready');
} finally {
  await db.end();
}
