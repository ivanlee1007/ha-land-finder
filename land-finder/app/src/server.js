import express from 'express';
import { pool, ensureSchema } from './db.js';
import { PORT, REGIONS, SEARCH } from './config.js';
import { scrapeIntoDb } from './scraper-core.js';
import { recomputeCpValues, cpForRow } from './valuation.js';
import { backfillDetails } from './detail-fetcher.js';
import { importLvrLand, countyCodesForRegionIds } from './lvr-importer.js';
import { updateLvrMatches } from './lvr-stats.js';
import { updateLvrHouseMatches } from './lvr-house-stats.js';
import { scrapeYes319Mvp } from './yes319-mvp.js';

const app = express();
const db = await pool();
await ensureSchema(db);
await db.execute("UPDATE properties SET listing_status='unavailable', unavailable_at=COALESCE(unavailable_at, detail_fetched_at, updated_at, CURRENT_TIMESTAMP) WHERE (detail_error LIKE 'detail HTTP 404%' OR detail_error LIKE 'detail unavailable%') AND COALESCE(listing_status, 'active') <> 'unavailable'");
app.use(express.json());
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(new URL('../public', import.meta.url).pathname));

function keywordList(v) {
  return String(v || '').split(/[\n,，;；]+/).map(s => s.trim()).filter(Boolean).slice(0, 20);
}

function addContentKeywordFilter(where, params, keywords, mode) {
  const fields = [
    "COALESCE(title, '')", "COALESCE(region_name, '')", "COALESCE(address, '')", "COALESCE(section_name, '')", "COALESCE(segment_name, '')", "COALESCE(unit_price, '')", "COALESCE(road_text, '')",
    "COALESCE(property_type, '')", "COALESCE(sale_kind, '')", "COALESCE(layout_text, '')", "COALESCE(bedroom_count, '')", "COALESCE(community_name, '')", "COALESCE(floor_text, '')", "COALESCE(parking_text, '')", "COALESCE(house_age, '')",
    "COALESCE(zoning, '')", "COALESCE(land_category, '')", "COALESCE(ownership, '')",
    "COALESCE(frontage_depth, '')", "COALESCE(infrastructure, '')", "COALESCE(disliked_facilities, '')",
    "COALESCE(detail_description, '')", 'CAST(tags AS CHAR)', 'CAST(raw AS CHAR)', "COALESCE(CAST(detail_json AS CHAR), '')"
  ];
  for (const kw of keywords) {
    const clause = `(${fields.map(f => `${f} LIKE ?`).join(' OR ')})`;
    where.push(mode === 'exclude' ? `NOT ${clause}` : clause);
    params.push(...fields.map(() => `%${kw}%`));
  }
}


const DEFAULT_LVR_SEASONS = ['115S1','114S4','114S3','114S2','114S1','113S4','113S3','113S2','113S1','112S4','112S3','112S2','112S1'];

const DEFAULT_RUNTIME_CONFIG = {
  updateMode: 'manual',
  autoIntervalMinutes: 360,
  useCurrentSearch: true,
  notifyEnabled: false,
  notifyOnlyNew: true,
  notifyMinMatches: 1,
  notifyTarget: '',
  lastAutoRunAt: null,
  nextAutoRunAt: null,
  lastNotification: null
};
let runtimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
let schedulerTimer = null;

function sanitizeRuntimeConfig(value = {}) {
  const minutes = Math.trunc(Math.max(5, Math.min(10080, Number(value.autoIntervalMinutes || DEFAULT_RUNTIME_CONFIG.autoIntervalMinutes))));
  return {
    ...DEFAULT_RUNTIME_CONFIG,
    ...value,
    updateMode: value.updateMode === 'auto' ? 'auto' : 'manual',
    autoIntervalMinutes: minutes,
    useCurrentSearch: value.useCurrentSearch !== false,
    notifyEnabled: value.notifyEnabled === true,
    notifyOnlyNew: value.notifyOnlyNew !== false,
    notifyMinMatches: Math.trunc(Math.max(0, Number(value.notifyMinMatches ?? DEFAULT_RUNTIME_CONFIG.notifyMinMatches))),
    notifyTarget: String(value.notifyTarget || '').slice(0, 256),
    lastAutoRunAt: value.lastAutoRunAt || null,
    nextAutoRunAt: value.nextAutoRunAt || null,
    lastNotification: value.lastNotification || null
  };
}

function toScrapeOptions(body = {}) {
  const criteria = body.criteria && typeof body.criteria === 'object' ? body.criteria : body;
  return {
    propertyType: criteria.propertyType === 'house' ? 'house' : 'land',
    sectionNames: Array.isArray(criteria.sectionNames) ? criteria.sectionNames.map(String).filter(Boolean) : [],
    maxPriceWan: Math.max(1, Number(criteria.maxPriceWan || (criteria.propertyType === 'house' ? 1000 : SEARCH.maxPriceWan))),
    minAreaPing: Math.max(1, Number(criteria.minAreaPing || (criteria.propertyType === 'house' ? 20 : SEARCH.minAreaPing))),
    regionIds: Array.isArray(criteria.regionIds) && criteria.regionIds.length ? criteria.regionIds.map(Number) : REGIONS.map(([id]) => id),
    landShapeIds: Array.isArray(criteria.landShapeIds) ? criteria.landShapeIds.map(String) : (criteria.requireFarmland !== false ? ['5'] : []),
    bedroomCounts: Array.isArray(criteria.bedroomCounts) ? criteria.bedroomCounts.map(Number).filter(Number.isFinite) : [],
    maxHouseAgeYear: criteria.maxHouseAgeYear === '' || criteria.maxHouseAgeYear == null ? null : Number(criteria.maxHouseAgeYear),
    parkingRequired: criteria.parkingRequired === true || criteria.parkingRequired === '1',
    requireRoad: criteria.propertyType === 'house' ? false : criteria.requireRoad !== false,
    maxPagesPerRegion: Math.max(1, Math.min(50, Number(criteria.maxPagesPerRegion || SEARCH.maxPagesPerRegion)))
  };
}

async function readSetting(key) {
  const [rows] = await db.execute('SELECT setting_value FROM app_settings WHERE setting_key=?', [key]);
  const value = rows[0]?.setting_value;
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return value; }
}

async function writeSetting(key, value) {
  await db.execute(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_at=CURRENT_TIMESTAMP`,
    [key, JSON.stringify(value || {})]
  );
}

function publicJob(job) {
  return job ? { ...job, controller: undefined } : { status: 'idle' };
}

function shouldUpdateRuntimeAfterRun(source) {
  return source === 'auto' || source === 'manual-run-now';
}

async function finishRuntimeRun(source, result, finishedAt) {
  if (!shouldUpdateRuntimeAfterRun(source)) return;
  runtimeConfig.lastAutoRunAt = finishedAt;
  if (runtimeConfig.notifyEnabled && Number(result?.matched || 0) >= runtimeConfig.notifyMinMatches) {
    runtimeConfig.lastNotification = {
      at: finishedAt,
      message: `${source === 'auto' ? '自動更新' : '手動立即更新'}完成：抓取 ${result.fetched}，符合 ${result.matched}，完整詳情 ${result.detailsFetched || 0}/${result.matched || 0}`,
      target: runtimeConfig.notifyTarget || 'local-ui'
    };
  }
  scheduleNextAutoRun();
  await writeSetting('runtime', runtimeConfig);
}

async function detailBackfillStats() {
  const [[row]] = await db.query(`
    SELECT
      SUM(CASE WHEN COALESCE(listing_status, 'active') <> 'unavailable'
        AND (detail_error IS NULL OR (detail_error NOT LIKE 'detail HTTP 404%' AND detail_error NOT LIKE 'detail unavailable%'))
        AND (detail_fetched_at IS NULL
          OR (property_type='land' AND (JSON_EXTRACT(detail_json, '$."土地介紹"') IS NULL OR COALESCE(detail_description, '') = '' OR detail_description REGEXP '更多在售詳情，就上591土地'))
          OR (property_type='house' AND (JSON_EXTRACT(detail_json, '$."屋況特色"') IS NULL OR COALESCE(detail_description, '') = '' OR COALESCE(floor_text, '') = ''))) THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN COALESCE(listing_status, 'active') = 'unavailable' OR detail_error LIKE 'detail HTTP 404%' OR detail_error LIKE 'detail unavailable%' THEN 1 ELSE 0 END) AS unavailable
    FROM properties
  `);
  return { missing: Number(row?.missing || 0), unavailable: Number(row?.unavailable || 0) };
}

function normalizeListingIntro(row) {
  const d = row?.detail_json && typeof row.detail_json === 'object' ? row.detail_json : (() => {
    try { return JSON.parse(row?.detail_json || '{}'); } catch { return {}; }
  })();
  return String(d['土地介紹'] || row?.detail_description || d.description || '').trim();
}

function withListingIntro(row) {
  return row ? { ...row, land_intro: normalizeListingIntro(row) } : row;
}

const propertySelectFields = `id,source_site,source_id,source_key,houseid,region_id,region_name,property_type,sale_kind,title,price_wan,area_ping,unit_price,layout_text,bedroom_count,community_name,floor_text,parking_text,house_age,house_age_year,address,section_name,segment_name,road_text,road_width_m,zoning,land_category,ownership,land_number,frontage_depth,infrastructure,disliked_facilities,detail_description,detail_json,detail_error,listing_status,unavailable_at,tags,photo_url,url,user_score,user_note,is_favorite,user_edited_at,cp_score,cp_note,cp_updated_at,lvr_match_level,lvr_sample_count,lvr_median_unit_wan,lvr_recent_years,lvr_basis_json,lvr_updated_at,detail_fetched_at,updated_at`;

function asNullableString(v, max = 512) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

function asNullableNumber(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeTagsInput(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[\n,，;；]+/);
  return [...new Set(arr.map(x => String(x).trim()).filter(Boolean))].slice(0, 40);
}

async function recomputeOneCp(id) {
  const [rows] = await db.query('SELECT id,region_id,region_name,property_type,sale_kind,layout_text,bedroom_count,community_name,floor_text,parking_text,house_age,house_age_year,title,price_wan,area_ping,unit_price,address,section_name,segment_name,road_text,road_width_m,ground_type,price_reduction_wan,browsenum_all,has_video,is_below_stand,is_high_value,zoning,land_category,ownership,frontage_depth,infrastructure,disliked_facilities,detail_description,detail_json,tags,raw,lvr_match_level,lvr_sample_count,lvr_median_unit_wan,lvr_recent_years,user_score FROM properties');
  const groups = [{}, {}, {}];
  const landType = row => {
    const tags = Array.isArray(row.tags) ? row.tags.map(String).join(' ') : String(row.tags || '');
    for (const t of ['農地', '建地', '住宅用地', '商業用地', '工業用地', '林地', '山坡地', '道路用地']) if (tags.includes(t)) return t;
    return '其他';
  };
  for (const row of rows) {
    const unit = Number(row.price_wan) / Number(row.area_ping);
    if (!Number.isFinite(unit) || unit <= 0) continue;
    const type = landType(row);
    const keys = [`${row.region_id}|${row.section_name || ''}|${type}`, `${row.region_id}|${type}`, `ALL|${type}`];
    keys.forEach((key, level) => { groups[level][key] ||= { units: [], prices: [] }; groups[level][key].units.push(unit); groups[level][key].prices.push(Number(row.price_wan)); });
  }
  const row = rows.find(r => Number(r.id) === Number(id));
  if (!row) return null;
  const cp = cpForRow(row, groups);
  await db.execute('UPDATE properties SET cp_score=?, cp_note=?, cp_updated_at=CURRENT_TIMESTAMP WHERE id=?', [cp.score, cp.note, id]);
  return cp;
}

function startScrapeJob(options, source = 'manual') {
  if (scrapeJob && ['running', 'stopping'].includes(scrapeJob.status)) return null;
  const progress = [];
  const controller = new AbortController();
  scrapeJob = { status: 'running', source, startedAt: new Date().toISOString(), options, progress, result: null, error: null, controller };
  scrapeIntoDb(db, { ...options, signal: controller.signal }, p => {
    progress.push(p);
    if (progress.length > 80) progress.shift();
  }).then(async result => {
    scrapeJob.status = result.status || 'ok';
    scrapeJob.finishedAt = new Date().toISOString();
    scrapeJob.result = result;
    delete scrapeJob.controller;
    await finishRuntimeRun(source, result, scrapeJob.finishedAt);
  }).catch(async err => {
    scrapeJob.status = 'error';
    scrapeJob.finishedAt = new Date().toISOString();
    scrapeJob.error = String(err.stack || err);
    delete scrapeJob.controller;
    if (shouldUpdateRuntimeAfterRun(source)) {
      runtimeConfig.lastAutoRunAt = scrapeJob.finishedAt;
      scheduleNextAutoRun();
      await writeSetting('runtime', runtimeConfig);
    }
  });
  return scrapeJob;
}

async function optionsForAutoRun() {
  if (!runtimeConfig.useCurrentSearch) return toScrapeOptions({});
  const saved = await readSetting('search');
  return toScrapeOptions(saved || {});
}

function scheduleNextAutoRun(from = Date.now()) {
  runtimeConfig.nextAutoRunAt = runtimeConfig.updateMode === 'auto'
    ? new Date(from + runtimeConfig.autoIntervalMinutes * 60_000).toISOString()
    : null;
}

async function schedulerTick() {
  if (runtimeConfig.updateMode !== 'auto') return;
  if (scrapeJob && ['running', 'stopping'].includes(scrapeJob.status)) return;
  const next = runtimeConfig.nextAutoRunAt ? Date.parse(runtimeConfig.nextAutoRunAt) : 0;
  if (!next || Date.now() >= next) startScrapeJob(await optionsForAutoRun(), 'auto');
}

async function loadRuntimeConfig() {
  runtimeConfig = sanitizeRuntimeConfig(await readSetting('runtime') || {});
  if (runtimeConfig.updateMode === 'auto' && !runtimeConfig.nextAutoRunAt) scheduleNextAutoRun();
  await writeSetting('runtime', runtimeConfig);
}

app.get('/api/properties', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.unavailableOnly === '1' || req.query.availability === 'unavailable') {
    where.push("(COALESCE(listing_status, 'active') = 'unavailable' OR detail_error LIKE 'detail HTTP 404%' OR detail_error LIKE 'detail unavailable%')");
  } else if (req.query.includeUnavailable !== '1' && req.query.availability !== 'all') {
    where.push("COALESCE(listing_status, 'active') <> 'unavailable'");
  }
  if (req.query.id) {
    const id = String(req.query.id || '').replace(/^S/i, '');
    where.push('(id=? OR houseid=?)');
    params.push(Number(id) || 0, /^S/i.test(String(req.query.id || '')) ? String(req.query.id) : `S${id}`);
  }
  if (req.query.propertyType) { where.push('property_type=?'); params.push(req.query.propertyType === 'house' ? 'house' : 'land'); }
  if (req.query.sourceSite) { where.push('source_site=?'); params.push(String(req.query.sourceSite).slice(0,32)); }
  if (req.query.region) { where.push('region_id=?'); params.push(Number(req.query.region)); }
  if (req.query.regions) {
    const ids = String(req.query.regions).split(',').map(Number).filter(Number.isFinite);
    if (ids.length) {
      where.push(`region_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
  }
  if (req.query.q) { where.push('(title LIKE ? OR address LIKE ? OR section_name LIKE ? OR JSON_SEARCH(tags, "one", ?) IS NOT NULL)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`); }
  addContentKeywordFilter(where, params, keywordList(req.query.contentInclude), 'include');
  addContentKeywordFilter(where, params, keywordList(req.query.contentExclude), 'exclude');
  if (req.query.sections) {
    const names = String(req.query.sections).split(',').map(s => s.trim()).filter(Boolean);
    if (names.length) {
      where.push(`section_name IN (${names.map(() => '?').join(',')})`);
      params.push(...names);
    }
  }
  if (req.query.maxPriceWan) { where.push('price_wan <= ?'); params.push(Number(req.query.maxPriceWan)); }
  if (req.query.minAreaPing) { where.push('area_ping >= ?'); params.push(Number(req.query.minAreaPing)); }
  if (req.query.bedrooms) { const beds=String(req.query.bedrooms).split(',').map(Number).filter(Number.isFinite); if(beds.length){ where.push(`bedroom_count IN (${beds.map(()=>'?').join(',')})`); params.push(...beds); } }
  if (req.query.maxHouseAgeYear) { where.push('(house_age_year IS NULL OR house_age_year <= ?)'); params.push(Number(req.query.maxHouseAgeYear)); }
  if (req.query.parkingRequired === '1') { where.push("COALESCE(parking_text,'') <> ''"); }
  if (req.query.floorLevel) {
    const f=String(req.query.floorLevel);
    if(f==='high') where.push("(floor_text LIKE '%高樓%' OR title LIKE '%高樓%')");
    else if(f==='low') where.push("(floor_text LIKE '%低樓%' OR floor_text LIKE '1F/%' OR floor_text LIKE '2F/%' OR floor_text LIKE '3F/%' OR floor_text LIKE '整棟%' OR title LIKE '%低樓%' OR title LIKE '%透天%')");
    else if(f==='mid') where.push("(floor_text LIKE '%中樓%' OR floor_text LIKE '4F/%' OR floor_text LIKE '5F/%' OR floor_text LIKE '6F/%' OR title LIKE '%中樓%')");
    else if(f==='top') where.push("(floor_text LIKE '%頂樓%' OR title LIKE '%頂樓%')");
    else if(f==='not_top') where.push("NOT (COALESCE(floor_text,'') LIKE '%頂樓%' OR title LIKE '%頂樓%')");
  }
  if (req.query.layout) { where.push('layout_text LIKE ?'); params.push(`%${req.query.layout}%`); }
  if (req.query.propertyType !== 'house' && req.query.requireRoad === '1') {
    where.push('(road_text LIKE ? OR road_text REGEXP ? OR JSON_SEARCH(tags, "one", ?) IS NOT NULL OR JSON_SEARCH(tags, "one", ?) IS NOT NULL)');
    params.push('%臨路%', '[0-9]+(\\.[0-9]+)?[[:space:]]*米', '%臨路%', '%有臨路%');
  }
  if (req.query.propertyType !== 'house' && req.query.landShapeIds) {
    const shapeNames = { '1':'住宅用地', '2':'商業用地', '3':'工業用地', '4':'建地', '5':'農地', '6':'林地', '7':'其他', '8':'山坡地', '10':'道路用地' };
    const names = String(req.query.landShapeIds).split(',').map(id => shapeNames[id]).filter(Boolean);
    if (names.length) {
      where.push(`(${names.map(() => 'JSON_SEARCH(tags, "one", ?) IS NOT NULL').join(' OR ')})`);
      params.push(...names.map(name => `%${name}%`));
    }
  }
  const sortMap = {
    price_asc: 'price_wan ASC, area_ping DESC',
    price_desc: 'price_wan DESC, area_ping DESC',
    area_desc: 'area_ping DESC, price_wan ASC',
    area_asc: 'area_ping ASC, price_wan ASC',
    unit_asc: '(price_wan / NULLIF(area_ping, 0)) ASC, price_wan ASC',
    unit_desc: '(price_wan / NULLIF(area_ping, 0)) DESC, price_wan ASC',
    updated_desc: 'updated_at DESC, price_wan ASC',
    updated_asc: 'updated_at ASC, price_wan ASC',
    region_asc: 'region_name ASC, price_wan ASC',
    region_desc: 'region_name DESC, price_wan ASC',
    title_asc: 'title ASC, price_wan ASC',
    title_desc: 'title DESC, price_wan ASC',
    cp_desc: 'cp_score DESC, (price_wan / NULLIF(area_ping, 0)) ASC',
    cp_asc: 'cp_score ASC, (price_wan / NULLIF(area_ping, 0)) ASC'
  };
  const orderBy = sortMap[req.query.sort] || sortMap.cp_desc;
  const pageSize = Math.trunc(Math.max(1, Math.min(500, Number(req.query.pageSize || 500))));
  const page = Math.trunc(Math.max(1, Number(req.query.page || 1)));
  const offset = Math.trunc((page - 1) * pageSize);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [countRows] = await db.execute(`SELECT COUNT(*) AS total FROM properties ${whereSql}`, params);
  const sql = `SELECT ${propertySelectFields}
    FROM properties ${whereSql}
    ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`;
  const [rows] = await db.execute(sql, params);
  const normalizedRows = rows.map(withListingIntro);
  if (req.query.meta === '1') return res.json({ rows: normalizedRows, total: Number(countRows[0]?.total || 0), page, pageSize });
  res.json(normalizedRows);
});


app.delete('/api/properties/unavailable', async (req, res) => {
  const keepFavorites = req.query.keepFavorites !== '0';
  const where = ["(COALESCE(listing_status, 'active') = 'unavailable' OR detail_error LIKE 'detail HTTP 404%' OR detail_error LIKE 'detail unavailable%')"];
  if (keepFavorites) where.push('COALESCE(is_favorite,0)=0');
  const [result] = await db.execute(`DELETE FROM properties WHERE ${where.join(' AND ')}`);
  res.json({ ok: true, deleted: Number(result.affectedRows || 0), keepFavorites });
});

app.post('/api/properties/:id/mark-unavailable', async (req, res) => {
  const id = Number(String(req.params.id || '').replace(/^S/i, ''));
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  const [result] = await db.execute("UPDATE properties SET listing_status='unavailable', unavailable_at=COALESCE(unavailable_at, CURRENT_TIMESTAMP), detail_error=COALESCE(detail_error, 'manual unavailable') WHERE id=?", [id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'not_found' });
  const [rows] = await db.execute(`SELECT ${propertySelectFields} FROM properties WHERE id=? LIMIT 1`, [id]);
  res.json({ ok: true, property: withListingIntro(rows[0]) });
});

app.delete('/api/properties/:id', async (req, res) => {
  const id = Number(String(req.params.id || '').replace(/^S/i, ''));
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  const [rows] = await db.execute("SELECT id,title,is_favorite,listing_status,detail_error FROM properties WHERE id=? LIMIT 1", [id]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const row = rows[0];
  const unavailable = row.listing_status === 'unavailable' || String(row.detail_error || '').startsWith('detail HTTP 404') || String(row.detail_error || '').startsWith('detail unavailable');
  if (!unavailable && req.query.force !== '1') return res.status(409).json({ error: 'not_unavailable' });
  if (Number(row.is_favorite || 0) && req.query.force !== '1') return res.status(409).json({ error: 'favorite_protected' });
  await db.execute('DELETE FROM properties WHERE id=?', [id]);
  res.json({ ok: true, deleted: 1, id });
});



app.get('/api/properties/:id', async (req, res) => {
  const id = String(req.params.id || '').replace(/^S/i, '');
  const [rows] = await db.execute(`SELECT ${propertySelectFields}
    FROM properties WHERE id=? OR houseid=? LIMIT 1`, [Number(id) || 0, /^S/i.test(req.params.id || '') ? req.params.id : `S${id}`]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(withListingIntro(rows[0]));
});

app.put('/api/properties/:id', async (req, res) => {
  const id = Number(String(req.params.id || '').replace(/^S/i, ''));
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  const [existing] = await db.execute('SELECT id FROM properties WHERE id=? LIMIT 1', [id]);
  if (!existing.length) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const price = asNullableNumber(b.price_wan);
  const area = asNullableNumber(b.area_ping);
  const userScore = Math.max(-30, Math.min(30, Number(b.user_score || 0)));
  const unitPrice = price && area ? `${(price / area).toFixed(1)}萬/坪` : asNullableString(b.unit_price, 64);
  const tags = normalizeTagsInput(b.tags);
  await db.execute(`UPDATE properties SET
    title=?, price_wan=?, area_ping=?, unit_price=?, address=?, section_name=?, segment_name=?, road_text=?, road_width_m=?,
    zoning=?, land_category=?, ownership=?, land_number=?, frontage_depth=?, infrastructure=?, disliked_facilities=?,
    detail_description=?, tags=?, user_score=?, user_note=?, is_favorite=?, user_edited_at=CURRENT_TIMESTAMP
    WHERE id=?`, [
    asNullableString(b.title, 512) || '', price, area, unitPrice, asNullableString(b.address, 255), asNullableString(b.section_name, 64),
    asNullableString(b.segment_name, 128), asNullableString(b.road_text, 128), asNullableNumber(b.road_width_m), asNullableString(b.zoning, 255),
    asNullableString(b.land_category, 128), asNullableString(b.ownership, 64), asNullableString(b.land_number, 128), asNullableString(b.frontage_depth, 128),
    asNullableString(b.infrastructure, 255), asNullableString(b.disliked_facilities, 255), asNullableString(b.detail_description, 5000),
    JSON.stringify(tags), userScore, asNullableString(b.user_note, 2000), b.is_favorite ? 1 : 0, id
  ]);
  await recomputeOneCp(id);
  const [rows] = await db.execute(`SELECT ${propertySelectFields} FROM properties WHERE id=? LIMIT 1`, [id]);
  res.json({ ok: true, property: withListingIntro(rows[0]) });
});


app.post('/api/yes319/mvp-import', async (req, res) => {
  const limit = Math.max(1, Math.min(30, Number(req.body?.limit || 12)));
  const progress = [];
  try {
    const result = await scrapeYes319Mvp(db, { detailLimit: limit, criteria: req.body || {} }, p => {
      progress.push(p);
      if (progress.length > 80) progress.shift();
    });
    res.json({ ...result, progress });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err), progress });
  }
});

app.post('/api/cp/recompute', async (_req, res) => {
  const lvr = await updateLvrMatches(db, { yearsBack: 5 });
  const houseLvr = await updateLvrHouseMatches(db, { yearsBack: 5 });
  const cp = await recomputeCpValues(db);
  res.json({ ok: true, lvr, houseLvr, cp });
});

app.post('/api/lvr/import', async (req, res) => {
  try {
    const seasons = Array.isArray(req.body?.seasons) && req.body.seasons.length ? req.body.seasons.map(String) : DEFAULT_LVR_SEASONS;
    const requestedCountyCodes = Array.isArray(req.body?.countyCodes) ? req.body.countyCodes.map(String).filter(Boolean) : [];
    const requestedRegionIds = Array.isArray(req.body?.regionIds) ? req.body.regionIds : [];
    const countyCodes = requestedCountyCodes.length ? [...new Set(requestedCountyCodes)] : countyCodesForRegionIds(requestedRegionIds);
    const lvrImport = await importLvrLand(db, { seasons, ...(countyCodes.length ? { countyCodes } : {}) });
    const lvr = await updateLvrMatches(db, { yearsBack: 5 });
    const houseLvr = await updateLvrHouseMatches(db, { yearsBack: 5 });
    const cp = await recomputeCpValues(db);
    res.json({ ok: true, import: lvrImport, countyCodes: countyCodes.length ? countyCodes : null, lvr, houseLvr, cp });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

let detailJob = null;

function publicDetailJob() {
  return detailJob ? { ...detailJob, controller: undefined } : { status: 'idle' };
}

async function startDetailJob({ mode = 'batch', limit = 80 } = {}) {
  if (detailJob && ['running', 'stopping'].includes(detailJob.status)) return null;
  const stats = await detailBackfillStats();
  const controller = new AbortController();
  detailJob = {
    status: 'running', mode, limit: mode === 'all' ? 500 : Math.max(1, Math.min(500, Number(limit) || 80)),
    startedAt: new Date().toISOString(), beforeMissing: stats.missing, progress: [], result: null, error: null, controller
  };
  (async () => {
    let totalUpdated = 0;
    try {
      do {
        if (controller.signal.aborted) throw new Error(controller.signal.reason || '補抓已停止');
        const batch = await backfillDetails(db, { limit: detailJob.limit, signal: controller.signal }, p => {
          detailJob.progress.push(p);
          if (detailJob.progress.length > 120) detailJob.progress.shift();
        });
        totalUpdated += Number(batch.updated || 0);
        detailJob.lastBatch = batch;
        const after = await detailBackfillStats();
        detailJob.remainingMissing = after.missing;
        if (mode !== 'all' || !batch.updated || !after.missing) break;
      } while (true);
      const lvr = await updateLvrMatches(db, { yearsBack: 5 });
      const houseLvr = await updateLvrHouseMatches(db, { yearsBack: 5 });
      const cp = await recomputeCpValues(db);
      const after = await detailBackfillStats();
      detailJob.status = 'ok';
      detailJob.finishedAt = new Date().toISOString();
      detailJob.result = { detail: { updated: totalUpdated, remainingMissing: after.missing }, lvr, houseLvr, cp };
    } catch (err) {
      detailJob.status = controller.signal.aborted ? 'cancelled' : 'error';
      detailJob.finishedAt = new Date().toISOString();
      detailJob.error = String(err.message || err);
    } finally {
      delete detailJob.controller;
    }
  })();
  return detailJob;
}

app.post('/api/details/backfill', async (req, res) => {
  const job = await startDetailJob({ mode: req.body?.mode || 'batch', limit: req.body?.limit || 80 });
  if (!job) return res.status(409).json({ error: 'detail_job_running' });
  res.json({ ok: true, job: publicDetailJob() });
});

app.get('/api/details/backfill/status', async (_req, res) => {
  const stats = await detailBackfillStats();
  res.json({ job: publicDetailJob(), stats });
});

app.post('/api/details/backfill/stop', (_req, res) => {
  if (detailJob?.status !== 'running') return res.status(409).json({ error: 'no_running_detail_job' });
  detailJob.status = 'stopping';
  detailJob.stopRequestedAt = new Date().toISOString();
  detailJob.controller?.abort('使用者停止補抓詳情');
  res.json({ ok: true, job: publicDetailJob() });
});

app.get('/api/search-options', async (req, res) => {
  const propertyType = req.query.propertyType === 'house' ? 'house' : 'land';
  const [sections] = await db.query(`
    SELECT region_id, region_name, section_name, COUNT(*) AS count
    FROM properties
    WHERE property_type=?
      AND section_name IS NOT NULL AND section_name <> ''
    GROUP BY region_id, region_name, section_name
    ORDER BY region_id ASC, section_name ASC
  `, [propertyType]);
  res.json({ regions: REGIONS.map(([id, name]) => ({ id, name })), sections, defaults: SEARCH });
});

app.get('/api/settings/:key', async (req, res) => {
  const [rows] = await db.execute('SELECT setting_value, updated_at FROM app_settings WHERE setting_key=?', [req.params.key]);
  if (!rows.length) return res.json({ value: null });
  let value = rows[0].setting_value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch {}
  }
  res.json({ value, updatedAt: rows[0].updated_at });
});

app.put('/api/settings/:key', async (req, res) => {
  await db.execute(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_at=CURRENT_TIMESTAMP`,
    [req.params.key, JSON.stringify(req.body || {})]
  );
  res.json({ ok: true });
});

app.get('/api/saved-searches', async (_req, res) => {
  const [rows] = await db.query('SELECT id,name,criteria,created_at,updated_at FROM saved_searches ORDER BY updated_at DESC, id DESC');
  res.json(rows);
});

app.post('/api/saved-searches', async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 128);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const criteria = body.criteria && typeof body.criteria === 'object' ? body.criteria : {};
  const [r] = await db.execute('INSERT INTO saved_searches (name, criteria) VALUES (?, ?)', [name, JSON.stringify(criteria)]);
  const [rows] = await db.execute('SELECT id,name,criteria,created_at,updated_at FROM saved_searches WHERE id=?', [r.insertId]);
  res.json(rows[0]);
});

app.put('/api/saved-searches/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 128);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  if (!name) return res.status(400).json({ error: 'name_required' });
  const criteria = body.criteria && typeof body.criteria === 'object' ? body.criteria : {};
  const [r] = await db.execute('UPDATE saved_searches SET name=?, criteria=? WHERE id=?', [name, JSON.stringify(criteria), id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  const [rows] = await db.execute('SELECT id,name,criteria,created_at,updated_at FROM saved_searches WHERE id=?', [id]);
  res.json(rows[0]);
});

app.delete('/api/saved-searches/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  await db.execute('DELETE FROM saved_searches WHERE id=?', [id]);
  res.json({ ok: true });
});

let scrapeJob = null;
await loadRuntimeConfig();
schedulerTimer = setInterval(() => schedulerTick().catch(err => console.error('scheduler tick failed', err)), 30_000);
schedulerTimer.unref?.();

app.post('/api/rescrape', async (req, res) => {
  const job = startScrapeJob(toScrapeOptions(req.body || {}), 'manual');
  if (!job) return res.status(409).json({ error: 'scrape_running' });
  res.json({ ok: true, job: publicJob(job) });
});

app.post('/api/rescrape/stop', (_req, res) => {
  if (scrapeJob?.status !== 'running') return res.status(409).json({ error: 'no_running_scrape' });
  scrapeJob.status = 'stopping';
  scrapeJob.stopRequestedAt = new Date().toISOString();
  scrapeJob.controller?.abort('使用者停止搜尋');
  res.json({ ok: true, job: { ...scrapeJob, controller: undefined } });
});

app.get('/api/rescrape/status', (_req, res) => {
  res.json(publicJob(scrapeJob));
});

app.post('/api/rescrape/clear', (_req, res) => {
  if (scrapeJob && ['running', 'stopping'].includes(scrapeJob.status)) return res.status(409).json({ error: 'scrape_running' });
  scrapeJob = null;
  res.json({ ok: true });
});


app.get('/api/runtime-config', (_req, res) => {
  res.json({ value: runtimeConfig, job: publicJob(scrapeJob) });
});

app.put('/api/runtime-config', async (req, res) => {
  runtimeConfig = sanitizeRuntimeConfig(req.body || {});
  scheduleNextAutoRun();
  await writeSetting('runtime', runtimeConfig);
  res.json({ ok: true, value: runtimeConfig });
});

app.post('/api/runtime-run-now', async (_req, res) => {
  const job = startScrapeJob(await optionsForAutoRun(), 'manual-run-now');
  if (!job) return res.status(409).json({ error: 'scrape_running' });
  res.json({ ok: true, job: publicJob(job) });
});

app.get('/api/runs', async (_req, res) => {
  const [rows] = await db.query('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 20');
  res.json(rows);
});

app.listen(PORT, '127.0.0.1', () => console.log(`591 land finder: http://127.0.0.1:${PORT}`));
