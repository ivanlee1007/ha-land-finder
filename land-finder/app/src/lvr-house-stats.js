const median = values => {
  const a = values.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const normalizeText = v => String(v || '').replace(/臺/g, '台').trim();

async function fetchStats(db, row, level, yearsBack) {
  const params = [Number(row.region_id) || 0, yearsBack];
  const where = [`region_id=?`, `unit_price_wan_ping > 0`, `transaction_year >= YEAR(CURDATE()) - ?`];
  if (level === 'section') {
    if (!row.section_name) return null;
    where.push(`section_name=?`);
    params.push(row.section_name);
  } else if (level !== 'region') return null;
  const [rows] = await db.execute(`SELECT unit_price_wan_ping, transaction_year, section_name, address, building_area_ping, total_price_ntd, building_type, layout_text, parking_text FROM lvr_house_transactions WHERE ${where.join(' AND ')} ORDER BY transaction_year DESC`, params);
  if (!rows.length) return null;
  const units = rows.map(r => Number(r.unit_price_wan_ping)).filter(Number.isFinite);
  if (!units.length) return null;
  const years = rows.map(r => Number(r.transaction_year)).filter(Number.isFinite);
  const recent = rows.slice(0, 6).map(r => ({
    year: Number(r.transaction_year) || null,
    section: r.section_name || '',
    position: r.address || '',
    areaPing: Number(r.building_area_ping) || null,
    totalWan: r.total_price_ntd != null ? Math.round(Number(r.total_price_ntd) / 10000) : null,
    unitWan: Number(r.unit_price_wan_ping) || null,
    type: r.building_type || '',
    layout: r.layout_text || '',
    parking: r.parking_text || ''
  }));
  return { level, type: 'house', count: units.length, median: median(units), minYear: Math.min(...years), maxYear: Math.max(...years), recent };
}

export async function lvrHouseStatsForProperty(db, row, { yearsBack = 5 } = {}) {
  for (const level of ['section', 'region']) {
    const s = await fetchStats(db, row, level, yearsBack);
    if (s && s.count >= (level === 'section' ? 5 : 12)) return s;
  }
  for (const level of ['section', 'region']) {
    const s = await fetchStats(db, row, level, yearsBack);
    if (s && s.count) return s;
  }
  return null;
}

export async function updateLvrHouseMatches(db, { yearsBack = 5 } = {}) {
  const [rows] = await db.query("SELECT id,region_id,section_name,title,price_wan,area_ping,layout_text,bedroom_count,community_name FROM properties WHERE property_type='house'");
  let updated = 0, matched = 0;
  for (const row of rows) {
    const s = await lvrHouseStatsForProperty(db, row, { yearsBack });
    if (s) matched++;
    await db.execute(`UPDATE properties SET lvr_match_level=?, lvr_sample_count=?, lvr_median_unit_wan=?, lvr_recent_years=?, lvr_basis_json=?, lvr_updated_at=CURRENT_TIMESTAMP WHERE id=?`, [
      s?.level || null,
      s?.count || 0,
      s?.median || null,
      s ? `${s.minYear || ''}-${s.maxYear || ''}` : null,
      s ? JSON.stringify({ type: s.type, recent: s.recent || [] }) : null,
      row.id
    ]);
    updated++;
  }
  return { updated, matched };
}
