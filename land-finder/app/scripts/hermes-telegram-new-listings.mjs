#!/usr/bin/env node
import { pool, ensureSchema } from '../src/db.js';
import { REGIONS, SEARCH } from '../src/config.js';
import { scrapeIntoDb } from '../src/scraper-core.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const noScrape = args.has('--no-scrape');
const STATE_KEY = 'telegram_new_listing_notifier';

function jsonValue(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function readSetting(db, key) {
  const [rows] = await db.execute('SELECT setting_value FROM app_settings WHERE setting_key=?', [key]);
  return jsonValue(rows[0]?.setting_value, null);
}

async function writeSetting(db, key, value) {
  if (dryRun) return;
  await db.execute(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_at=CURRENT_TIMESTAMP`,
    [key, JSON.stringify(value || {})]
  );
}

function currentCriteria(searchSetting) {
  if (searchSetting?.criteria && typeof searchSetting.criteria === 'object') return searchSetting.criteria;
  return searchSetting && typeof searchSetting === 'object' ? searchSetting : {};
}

function toScrapeOptions(criteria = {}) {
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

function keywordList(v) {
  return String(v || '').split(/[\n,，;；]+/).map(s => s.trim()).filter(Boolean).slice(0, 20);
}

function addKeywordFilter(where, params, keywords, mode) {
  const fields = [
    "COALESCE(title, '')", "COALESCE(region_name, '')", "COALESCE(address, '')", "COALESCE(section_name, '')", "COALESCE(segment_name, '')", "COALESCE(unit_price, '')", "COALESCE(road_text, '')",
    "COALESCE(property_type, '')", "COALESCE(sale_kind, '')", "COALESCE(layout_text, '')", "COALESCE(bedroom_count, '')", "COALESCE(community_name, '')", "COALESCE(floor_text, '')", "COALESCE(parking_text, '')", "COALESCE(house_age, '')",
    "COALESCE(zoning, '')", "COALESCE(land_category, '')", "COALESCE(ownership, '')", "COALESCE(frontage_depth, '')", "COALESCE(infrastructure, '')", "COALESCE(disliked_facilities, '')",
    "COALESCE(detail_description, '')", 'CAST(tags AS CHAR)', 'CAST(raw AS CHAR)', "COALESCE(CAST(detail_json AS CHAR), '')"
  ];
  for (const kw of keywords) {
    const clause = `(${fields.map(f => `${f} LIKE ?`).join(' OR ')})`;
    where.push(mode === 'exclude' ? `NOT ${clause}` : clause);
    params.push(...fields.map(() => `%${kw}%`));
  }
}

function addCriteriaFilters(criteria, where, params) {
  const propertyType = criteria.propertyType === 'house' ? 'house' : 'land';
  where.push('property_type=?');
  params.push(propertyType);
  if (criteria.sourceSite) { where.push('source_site=?'); params.push(String(criteria.sourceSite).slice(0, 32)); }
  const regionIds = Array.isArray(criteria.regionIds) && criteria.regionIds.length ? criteria.regionIds.map(Number).filter(Number.isFinite) : [];
  if (regionIds.length) { where.push(`region_id IN (${regionIds.map(() => '?').join(',')})`); params.push(...regionIds); }
  if (criteria.q) {
    where.push('(title LIKE ? OR address LIKE ? OR section_name LIKE ? OR JSON_SEARCH(tags, "one", ?) IS NOT NULL)');
    params.push(`%${criteria.q}%`, `%${criteria.q}%`, `%${criteria.q}%`, `%${criteria.q}%`);
  }
  addKeywordFilter(where, params, keywordList(criteria.contentInclude), 'include');
  addKeywordFilter(where, params, keywordList(criteria.contentExclude), 'exclude');
  const sections = Array.isArray(criteria.sectionNames) ? criteria.sectionNames.map(String).filter(Boolean) : [];
  if (sections.length) { where.push(`section_name IN (${sections.map(() => '?').join(',')})`); params.push(...sections); }
  if (criteria.maxPriceWan) { where.push('price_wan <= ?'); params.push(Number(criteria.maxPriceWan)); }
  if (criteria.minAreaPing) { where.push('area_ping >= ?'); params.push(Number(criteria.minAreaPing)); }
  const beds = Array.isArray(criteria.bedroomCounts) ? criteria.bedroomCounts.map(Number).filter(Number.isFinite) : [];
  if (beds.length) { where.push(`bedroom_count IN (${beds.map(() => '?').join(',')})`); params.push(...beds); }
  if (criteria.maxHouseAgeYear) { where.push('(house_age_year IS NULL OR house_age_year <= ?)'); params.push(Number(criteria.maxHouseAgeYear)); }
  if (criteria.parkingRequired === true || criteria.parkingRequired === '1') where.push("COALESCE(parking_text,'') <> ''");
  if (propertyType !== 'house' && criteria.requireRoad !== false) {
    where.push('(road_text LIKE ? OR JSON_SEARCH(tags, "one", ?) IS NOT NULL OR JSON_SEARCH(tags, "one", ?) IS NOT NULL)');
    params.push('%臨路%', '%臨路%', '%有臨路%');
  }
  if (propertyType !== 'house' && Array.isArray(criteria.landShapeIds) && criteria.landShapeIds.length) {
    const shapeNames = { '1':'住宅用地', '2':'商業用地', '3':'工業用地', '4':'建地', '5':'農地', '6':'林地', '7':'其他', '8':'山坡地', '10':'道路用地' };
    const names = criteria.landShapeIds.map(id => shapeNames[String(id)]).filter(Boolean);
    if (names.length) { where.push(`(${names.map(() => 'JSON_SEARCH(tags, "one", ?) IS NOT NULL').join(' OR ')})`); params.push(...names.map(name => `%${name}%`)); }
  }
}

async function fetchNewRows(db, sinceIso, untilIso, criteria) {
  const where = ['first_seen_at > ?', 'first_seen_at <= ?'];
  const params = [sinceIso.slice(0, 19).replace('T', ' '), untilIso.slice(0, 19).replace('T', ' ')];
  addCriteriaFilters(criteria, where, params);
  const [rows] = await db.query(
    `SELECT id, houseid, title, region_name, section_name, address, price_wan, area_ping, unit_price, road_text, parking_text, house_age, cp_score, url, first_seen_at
     FROM properties
     WHERE ${where.join(' AND ')}
     ORDER BY first_seen_at ASC, price_wan ASC
     LIMIT 50`,
    params
  );
  return rows;
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString('zh-TW')}萬` : '-';
}

function area(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toLocaleString('zh-TW', { maximumFractionDigits: 1 })}坪` : '-';
}

function messageFor(rows, result, criteria) {
  const shown = rows.slice(0, 10);
  const lines = [
    `591 搜尋發現 ${rows.length} 筆第一次出現且符合條件的新物件`,
    `本輪抓取 ${result?.fetched ?? 0} 筆，符合 ${result?.matched ?? 0} 筆。`,
    ''
  ];
  shown.forEach((row, idx) => {
    const place = [row.region_name, row.section_name].filter(Boolean).join(' ');
    const extras = [row.road_text, row.parking_text, row.house_age ? `屋齡 ${row.house_age}` : '', row.cp_score != null ? `CP ${Number(row.cp_score).toFixed(1)}` : ''].filter(Boolean).join(' / ');
    lines.push(`${idx + 1}. ${row.title || row.houseid || row.id}`);
    lines.push(`${place}｜${money(row.price_wan)}｜${area(row.area_ping)}｜${row.unit_price || '-'}`);
    if (extras) lines.push(extras);
    lines.push(row.url || `https://sale.591.com.tw/home/house/detail/2/${row.id}.html`);
    lines.push('');
  });
  if (rows.length > shown.length) lines.push(`另有 ${rows.length - shown.length} 筆，請開啟本機 UI 查看。`);
  const summary = [criteria.propertyType === 'house' ? '中古屋' : '土地', criteria.maxPriceWan ? `≤${criteria.maxPriceWan}萬` : '', criteria.minAreaPing ? `≥${criteria.minAreaPing}坪` : ''].filter(Boolean).join(' / ');
  if (summary) lines.push(`條件：${summary}`);
  lines.push('UI：http://127.0.0.1:5910');
  return lines.join('\n').trim();
}

const db = await pool();
let lockAcquired = false;
try {
  await ensureSchema(db);
  const [[lockRow]] = await db.query("SELECT GET_LOCK('land591_telegram_new_listing_notifier', 0) AS got_lock");
  lockAcquired = Number(lockRow?.got_lock) === 1;
  if (!lockAcquired) process.exit(0);

  const now = new Date();
  const search = await readSetting(db, 'search');
  const runtime = await readSetting(db, 'runtime') || {};
  const state = await readSetting(db, STATE_KEY) || {};
  const criteria = currentCriteria(search);
  const sinceIso = state.lastCheckedAt || now.toISOString();
  const scrapeOptions = toScrapeOptions(criteria);
  const result = noScrape ? { fetched: 0, matched: 0, status: 'skipped' } : await scrapeIntoDb(db, scrapeOptions);
  const finishedIso = new Date().toISOString();
  const rows = await fetchNewRows(db, sinceIso, finishedIso, criteria);

  const nextState = {
    lastCheckedAt: finishedIso,
    lastRunAt: finishedIso,
    lastRunStatus: result.status || 'ok',
    lastFetched: result.fetched || 0,
    lastMatched: result.matched || 0,
    lastNewCount: rows.length
  };
  await writeSetting(db, STATE_KEY, nextState);

  if (rows.length) {
    const message = messageFor(rows, result, criteria);
    await writeSetting(db, 'runtime', {
      ...runtime,
      notifyEnabled: true,
      notifyOnlyNew: true,
      notifyTarget: runtime.notifyTarget || 'telegram:8309219201',
      lastAutoRunAt: finishedIso,
      lastNotification: { at: finishedIso, target: runtime.notifyTarget || 'telegram:8309219201', message }
    });
    console.log(message);
  } else {
    await writeSetting(db, 'runtime', { ...runtime, lastAutoRunAt: finishedIso });
    if (dryRun) console.log(`DRY RUN: no new listings. since=${sinceIso}, fetched=${result.fetched}, matched=${result.matched}`);
  }
} catch (err) {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
} finally {
  if (lockAcquired) {
    try { await db.query("SELECT RELEASE_LOCK('land591_telegram_new_listing_notifier')"); } catch {}
  }
  await db.end();
}
