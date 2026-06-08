import { pool, ensureSchema } from './db.js';
import { scrapeIntoDb } from './scraper-core.js';

const db = await pool();
try {
  await ensureSchema(db);
  const result = await scrapeIntoDb(db, {}, p => {
    console.log(`${p.regionName} p${p.page}: ${p.items} items, total=${p.total}, matched=${p.matched}`);
  });
  console.log(`Done. fetched=${result.fetched}, matched=${result.matched}`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await db.end();
}
