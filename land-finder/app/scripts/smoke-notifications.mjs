import { pool, ensureSchema } from '../src/db.js';

const db = await pool();
try {
  await ensureSchema(db);
  const [[prop]] = await db.query("SELECT id,title FROM properties ORDER BY updated_at DESC LIMIT 1");
  if (!prop) throw new Error('no properties available for notification smoke test');
  const runId = -Date.now();
  await db.execute(
    "INSERT INTO notification_events (run_id, property_id, event_type, title, message, channel, status) VALUES (?, ?, 'new_listing', ?, 'smoke test notification', 'local-ui', 'pending') ON DUPLICATE KEY UPDATE read_at=NULL, message=VALUES(message)",
    [runId, prop.id, `[smoke] ${prop.title || prop.id}`]
  );
  const [[unread]] = await db.query('SELECT COUNT(*) AS count FROM notification_events WHERE read_at IS NULL');
  const [[flag]] = await db.query("SELECT (SELECT COUNT(*) FROM notification_events ne WHERE ne.property_id=p.id AND ne.event_type='new_listing' AND ne.read_at IS NULL) AS new_notification_count FROM properties p WHERE p.id=?", [prop.id]);
  console.log(JSON.stringify({ ok: true, propertyId: prop.id, unread: Number(unread.count || 0), propertyNewCount: Number(flag.new_notification_count || 0) }));
  await db.execute("DELETE FROM notification_events WHERE property_id=? AND message='smoke test notification'", [prop.id]);
} finally {
  await db.end();
}
