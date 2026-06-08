const median = values => {
  const a = values.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const normalizeSegment = v => {
  const s = String(v || '').replace(/臺/g, '台').trim();
  if (!s) return '';
  if (s.endsWith('段')) return s;
  return s + '段';
};
const normalizeText = v => String(v || '').replace(/臺/g, '台').trim();
const isFarmType = text => /農牧用地|農業區|一般農業區|特定農業區|農地|都內農|一般農|特農/.test(text);
const isBuildType = text => /建地|住宅區|住|商業區|商|乙種建築|甲種建築|丙種建築|丁種建築|建築用地|工業區|工/.test(text);

function primaryType(row) {
  const txt = normalizeText([row.tags && JSON.stringify(row.tags), row.land_category, row.zoning, row.title].join(' '));
  if (isFarmType(txt)) return 'farm';
  if (isBuildType(txt)) return 'build';
  return 'other';
}
function lvrTypeExpr(type) {
  if (type === 'farm') return `(non_urban_use LIKE '%農牧%' OR non_urban_zone LIKE '%農業%' OR urban_zoning LIKE '%農%')`;
  if (type === 'build') return `(non_urban_use LIKE '%建築%' OR urban_zoning IN ('住','商','工') OR urban_zoning LIKE '%住宅%' OR urban_zoning LIKE '%商業%' OR urban_zoning LIKE '%工業%')`;
  return `1=1`;
}
async function fetchStats(db, row, level, yearsBack) {
  const type = primaryType(row);
  const params = [Number(row.region_id) || 0];
  let where = [`region_id=?`, `unit_price_wan_ping > 0`, `transaction_year >= YEAR(CURDATE()) - ?`, lvrTypeExpr(type)];
  params.push(yearsBack);
  if (level === 'segment') {
    const seg = normalizeSegment(row.segment_name);
    if (!seg || !row.section_name) return null;
    where.push(`section_name=?`, `(segment_name=? OR land_position LIKE ?)`);
    params.push(row.section_name || '', seg, `%${seg}%`);
  } else if (level === 'section') {
    if (!row.section_name) return null;
    where.push(`section_name=?`);
    params.push(row.section_name);
  } else if (level !== 'region') return null;
  const [rows] = await db.execute(`SELECT unit_price_wan_ping, transaction_year, section_name, segment_name, land_position, area_ping, total_price_ntd, urban_zoning, non_urban_zone, non_urban_use FROM lvr_land_transactions WHERE ${where.join(' AND ')} ORDER BY transaction_year DESC`, params);
  if (!rows.length) return null;
  const units = rows.map(r => Number(r.unit_price_wan_ping)).filter(Number.isFinite);
  if (!units.length) return null;
  const years = rows.map(r => Number(r.transaction_year)).filter(Number.isFinite);
  const recent = rows.slice(0, 6).map(r => ({
    year: Number(r.transaction_year) || null,
    section: r.section_name || '',
    segment: r.segment_name || '',
    position: r.land_position || '',
    areaPing: Number(r.area_ping) || null,
    totalWan: r.total_price_ntd != null ? Math.round(Number(r.total_price_ntd) / 10000) : null,
    unitWan: Number(r.unit_price_wan_ping) || null,
    zoning: r.urban_zoning || r.non_urban_zone || '',
    use: r.non_urban_use || ''
  }));
  return {
    level,
    type,
    count: units.length,
    median: median(units),
    minYear: Math.min(...years),
    maxYear: Math.max(...years),
    recent
  };
}
export async function lvrStatsForProperty(db, row, { yearsBack = 5 } = {}) {
  for (const level of ['segment', 'section', 'region']) {
    const s = await fetchStats(db, row, level, yearsBack);
    if (s && s.count >= (level === 'segment' ? 2 : level === 'section' ? 5 : 12)) return s;
  }
  // If strict thresholds fail, still return the best available nearby signal.
  for (const level of ['segment', 'section', 'region']) {
    const s = await fetchStats(db, row, level, yearsBack);
    if (s && s.count) return s;
  }
  return null;
}
export async function updateLvrMatches(db, { yearsBack = 5 } = {}) {
  const [rows] = await db.query("SELECT id,region_id,section_name,segment_name,title,tags,zoning,land_category,price_wan,area_ping FROM properties WHERE property_type='land'");
  let updated = 0, matched = 0;
  for (const row of rows) {
    const s = await lvrStatsForProperty(db, row, { yearsBack });
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
