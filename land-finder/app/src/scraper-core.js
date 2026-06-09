import { REGIONS, SEARCH } from './config.js';
import { recomputeCpValues } from './valuation.js';
import { fetchDetail } from './detail-fetcher.js';
import { updateLvrHouseMatches } from './lvr-house-stats.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = s => String(s || '').replace(/,/g, '').match(/[0-9]+(?:\.[0-9]+)?/)?.[0] ?? null;
const parsePriceWan = item => Number(digits(item?.price_arr?.price ?? item?.price));
const parseAreaPing = item => Number(digits(item?.areaUnit?.area ?? item?.area_str ?? item?.area));
const layoutTextOf = item => item.layout_str || item.layoutStr || String(item.area || '').match(/\d+房[^ ]*/)?.[0] || '';
const bedroomCountOf = item => { const m = layoutTextOf(item).match(/(\d+)房/); return m ? Number(m[1]) : null; };
const communityNameOf = item => item.community_info?.community_name || item.community_addr || '';
const floorTextOf = item => item.floor_str || item.floor || String(item.title || '').match(/高樓層|中樓層|低樓層|頂樓/)?.[0] || '';
const parkingTextOf = item => [...tagsOf(item), item.title, item.area, item.other?.join?.(' ') || ''].join(' ').match(/平車|機械車位|車位|車庫|坡平|坡道平面|坡道機械/)?.[0] || '';
const houseAgeTextOf = item => item.houseage || item.house_age || item.houseAge || '';
const houseAgeYearOf = item => { const v = Number(digits(houseAgeTextOf(item))); return Number.isFinite(v) && v > 0 ? v : null; };
const houseNumericId = item => Number(String(item.houseid || item.id || '').replace(/\D/g, ''));

function uniqueClean(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function tagsOf(item, propertyType = 'land') {
  const tags = uniqueClean([...(item.feat_tag || []), ...(item.tags || []), ...(item.labels || [])]);
  if (propertyType !== 'house') return tags;
  return tags.filter(t => !/^(住宅|中古屋)$/.test(t) && !/(\d+房|\d+廳|\d+衛|屋齡|樓層|車位|平車|機械車位|坡道|\d+(?:\.\d+)?坪)/.test(t));
}

function roadTextOf(item) {
  const tags = tagsOf(item, 'land');
  return tags.find(t => t.includes('有臨路') || t.includes('臨路')) || item.near_road || item.near_road_note || '';
}

function roadWidthOf(item) {
  const explicit = Number(digits(item.near_road_width));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Number(digits(roadTextOf(item)) || 0) || null;
}

function priceReductionWan(item) {
  const raw = item.price_reduction || item.operation_tag?.sub_title || '';
  const v = Number(digits(raw));
  return Number.isFinite(v) ? v : null;
}

function boolNum(v) {
  return ['1', 'true', 'yes'].includes(String(v || '').toLowerCase()) ? 1 : 0;
}

const PROPERTY_TYPES = { land: '土地', house: '中古屋' };

const LAND_SHAPES = {
  '1': '住宅用地',
  '2': '商業用地',
  '3': '工業用地',
  '4': '建地',
  '5': '農地',
  '6': '林地',
  '7': '其他',
  '8': '山坡地',
  '10': '道路用地'
};

function normalizeOptions(options = {}) {
  const propertyType = PROPERTY_TYPES[options.propertyType] ? options.propertyType : 'land';
  const maxPriceWan = Number(options.maxPriceWan ?? (propertyType === 'house' ? 1000 : SEARCH.maxPriceWan));
  const minAreaPing = Number(options.minAreaPing ?? (propertyType === 'house' ? 20 : SEARCH.minAreaPing));
  const pageSize = Number(options.pageSize ?? SEARCH.pageSize);
  const maxPagesPerRegion = Number(options.maxPagesPerRegion ?? SEARCH.maxPagesPerRegion);
  const requireRoad = propertyType === 'land' && options.requireRoad !== false;
  const legacyFarmland = propertyType === 'land' && options.requireFarmland !== false && !Array.isArray(options.landShapeIds);
  const landShapeIds = (Array.isArray(options.landShapeIds) ? options.landShapeIds : (legacyFarmland ? ['5'] : []))
    .map(String).filter(id => LAND_SHAPES[id]);
  const regionIds = (options.regionIds || REGIONS.map(([id]) => id)).map(Number);
  const regions = REGIONS.filter(([id]) => regionIds.includes(id));
  const sectionNames = Array.isArray(options.sectionNames) ? options.sectionNames.map(String).filter(Boolean) : [];
  const bedroomCounts = Array.isArray(options.bedroomCounts) ? options.bedroomCounts.map(Number).filter(Number.isFinite) : [];
  const maxHouseAgeYear = options.maxHouseAgeYear === '' || options.maxHouseAgeYear == null ? null : Number(options.maxHouseAgeYear);
  const parkingRequired = options.parkingRequired === true || options.parkingRequired === '1';
  return { propertyType, maxPriceWan, minAreaPing, pageSize, maxPagesPerRegion, requireRoad, landShapeIds, sectionNames, regions, bedroomCounts, maxHouseAgeYear, parkingRequired };
}

function saleKindOf(item, propertyType) {
  if (propertyType === 'house') return item.kindStr || '住宅';
  return '土地';
}

function hasSelectedLandShape(tags, options) {
  if (!options.landShapeIds.length) return true;
  const selectedNames = options.landShapeIds.map(id => LAND_SHAPES[id]);
  return selectedNames.some(name => tags.some(t => t.includes(name)));
}

function isMatch(item, options) {
  const tags = tagsOf(item, options.propertyType);
  const section = String(item.section || item.section_name || '');
  const price = parsePriceWan(item);
  const area = parseAreaPing(item);
  return Number.isFinite(price) && price <= options.maxPriceWan &&
    Number.isFinite(area) && area >= options.minAreaPing &&
    (options.propertyType === 'house' || hasSelectedLandShape(tags, options)) &&
    (!options.sectionNames.length || options.sectionNames.includes(section)) &&
    (options.propertyType !== 'house' || !options.bedroomCounts.length || options.bedroomCounts.includes(bedroomCountOf(item))) &&
    (options.propertyType !== 'house' || !Number.isFinite(options.maxHouseAgeYear) || !houseAgeYearOf(item) || houseAgeYearOf(item) <= options.maxHouseAgeYear) &&
    (options.propertyType !== 'house' || !options.parkingRequired || !!parkingTextOf(item)) &&
    (!options.requireRoad || tags.some(t => t.includes('有臨路') || t.includes('臨路')));
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    const err = new Error(signal.reason || '搜尋已停止');
    err.name = 'AbortError';
    throw err;
  }
}

function cancellableSleep(ms, signal) {
  if (!signal) return sleep(ms);
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const err = new Error(signal.reason || '搜尋已停止');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
}

async function fetchPage(regionId, page, options) {
  const qs = new URLSearchParams({
    module: 'iphone', action: 'businessList', device: 'touch', type: '2', kind: options.propertyType === 'house' ? '9' : '11',
    page_size: String(options.pageSize), page: String(page), region_id: String(regionId),
    multi_price: `0$_${options.maxPriceWan}$`, multi_area: `${options.minAreaPing}$_$`
  });
  if (options.propertyType === 'land' && options.landShapeIds.length) qs.set('land_shape', options.landShapeIds.join(','));
  // 591's BFF response includes sectionid, but local section filtering is kept after fetch
  // because the UI persists human-readable district names and section ids may vary by region/source.
  const url = `https://bff-house.591.com.tw/v2/php-api?${qs}`;
  const res = await fetch(url, {
    signal: options.signal,
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      'referer': options.propertyType === 'house' ? `https://sale.591.com.tw/list?type=2&kind=9&region=${regionId}` : `https://land.591.com.tw/list?type=2&kind=11&region=${regionId}`,
      'accept': 'application/json,text/plain,*/*'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const json = await res.json();
  if (!Number(json.status)) throw new Error(json.msg || `API status ${json.status}`);
  return json.data || { items: [], records: 0 };
}

async function upsert(conn, regionId, regionName, item, options, detail = null, detailError = null) {
  const id = houseNumericId(item);
  const propertyType = options?.propertyType || 'land';
  const tags = tagsOf(item, propertyType);
  const url = item.url || (propertyType === 'house' ? `https://sale.591.com.tw/home/house/detail/2/${id}.html` : `https://land.591.com.tw/sale/${id}`);
  const [existing] = await conn.execute('SELECT id FROM properties WHERE id=? LIMIT 1', [id]);
  await conn.execute(`
    INSERT INTO properties
      (id, houseid, region_id, region_name, title, price_wan, area_ping, unit_price, address,
       section_name, segment_name, road_text, road_width_m, ground_type, price_reduction_wan, browsenum_all,
       property_type, sale_kind, layout_text, bedroom_count, community_name, floor_text, parking_text, house_age, house_age_year,
       has_video, is_below_stand, is_high_value, tags, photo_url, url, raw,
       detail_json, detail_description, zoning, land_category, ownership, land_number, frontage_depth, infrastructure, disliked_facilities, detail_error, detail_fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      houseid=VALUES(houseid), region_id=VALUES(region_id), region_name=VALUES(region_name),
      title=IF(is_favorite=1,title,VALUES(title)), price_wan=IF(is_favorite=1,price_wan,VALUES(price_wan)), area_ping=IF(is_favorite=1,area_ping,VALUES(area_ping)),
      unit_price=IF(is_favorite=1,unit_price,VALUES(unit_price)), address=IF(is_favorite=1,address,VALUES(address)), section_name=IF(is_favorite=1,section_name,VALUES(section_name)),
      segment_name=IF(is_favorite=1,segment_name,VALUES(segment_name)), road_text=IF(is_favorite=1,road_text,VALUES(road_text)), road_width_m=IF(is_favorite=1,road_width_m,VALUES(road_width_m)),
      property_type=VALUES(property_type), sale_kind=VALUES(sale_kind), layout_text=VALUES(layout_text), bedroom_count=VALUES(bedroom_count), community_name=VALUES(community_name), floor_text=VALUES(floor_text), parking_text=VALUES(parking_text), house_age=VALUES(house_age), house_age_year=VALUES(house_age_year),
      ground_type=VALUES(ground_type), price_reduction_wan=VALUES(price_reduction_wan), browsenum_all=VALUES(browsenum_all),
      has_video=VALUES(has_video), is_below_stand=VALUES(is_below_stand), is_high_value=VALUES(is_high_value),
      tags=IF(is_favorite=1,tags,VALUES(tags)), photo_url=VALUES(photo_url), url=VALUES(url), raw=VALUES(raw),
      detail_json=IF(is_favorite=1 OR VALUES(detail_json) IS NULL, detail_json, VALUES(detail_json)),
      detail_description=IF(is_favorite=1 OR VALUES(detail_description) IS NULL, detail_description, VALUES(detail_description)),
      zoning=IF(is_favorite=1 OR VALUES(zoning) IS NULL, zoning, VALUES(zoning)),
      land_category=IF(is_favorite=1 OR VALUES(land_category) IS NULL, land_category, VALUES(land_category)),
      ownership=IF(is_favorite=1 OR VALUES(ownership) IS NULL, ownership, VALUES(ownership)),
      land_number=IF(is_favorite=1 OR VALUES(land_number) IS NULL, land_number, VALUES(land_number)),
      frontage_depth=IF(is_favorite=1 OR VALUES(frontage_depth) IS NULL, frontage_depth, VALUES(frontage_depth)),
      infrastructure=IF(is_favorite=1 OR VALUES(infrastructure) IS NULL, infrastructure, VALUES(infrastructure)),
      disliked_facilities=IF(is_favorite=1 OR VALUES(disliked_facilities) IS NULL, disliked_facilities, VALUES(disliked_facilities)),
      detail_error=VALUES(detail_error), detail_fetched_at=IF(VALUES(detail_fetched_at) IS NULL, detail_fetched_at, VALUES(detail_fetched_at)),
      listing_status='active',
      unavailable_at=NULL,
      updated_at=CURRENT_TIMESTAMP
  `, [
    id, item.houseid || `S${id}`, regionId, regionName, item.title || '', parsePriceWan(item), parseAreaPing(item),
    item.area_price || item.business_per_price || '', item.business_address || item.address || '', item.section || '',
    item.segment || item.small_segment || '', roadTextOf(item), roadWidthOf(item), item.ground_type || item.original_ground_type || '',
    priceReductionWan(item), Number(digits(item.browsenum_all)) || null, propertyType, saleKindOf(item, propertyType), detail?.layout_text || layoutTextOf(item), detail?.bedroom_count ?? bedroomCountOf(item), communityNameOf(item), detail?.floor_text || floorTextOf(item), detail?.parking_text || parkingTextOf(item), detail?.house_age || houseAgeTextOf(item), detail?.house_age_year ?? houseAgeYearOf(item),
    boolNum(item.is_video), boolNum(item.is_below_stand), boolNum(item.is_high_value),
    JSON.stringify(tags), item.photo_src || '', url, JSON.stringify(item),
    detail ? JSON.stringify(detail.detail_json || {}) : null,
    detail?.detail_description ?? null,
    detail?.zoning ?? null,
    detail?.land_category ?? null,
    detail?.ownership ?? null,
    detail?.land_number ?? null,
    detail?.frontage_depth ?? null,
    detail?.infrastructure ?? null,
    detail?.disliked_facilities ?? null,
    detailError,
    detail?.detail_fetched_at ?? (detailError ? new Date().toISOString().slice(0,19).replace('T',' ') : null)
  ]);
  return { id, isNew: existing.length === 0 };
}

async function fetchDetailForMatched(id, signal, propertyType = 'land') {
  try {
    return { detail: await fetchDetail(id, signal, propertyType), detailError: null };
  } catch (e) {
    const detailError = String(e.message || e);
    if (detailError.startsWith('detail HTTP 404')) return { detail: null, detailError };
    return { detail: null, detailError };
  }
}

async function markMissingMatchedRowsUnavailable(conn, options, seenIds) {
  if (!seenIds || !seenIds.size) return { markedUnavailable: 0, verifiedAvailable: 0, candidates: 0 };
  const where = ["source_site='591'", "property_type=?", "COALESCE(listing_status, 'active') <> 'unavailable'", 'price_wan <= ?', 'area_ping >= ?'];
  const params = [options.propertyType, options.maxPriceWan, options.minAreaPing];
  const regionIds = options.regions.map(([id]) => Number(id)).filter(Number.isFinite);
  if (regionIds.length) { where.push(`region_id IN (${regionIds.map(() => '?').join(',')})`); params.push(...regionIds); }
  if (options.sectionNames.length) { where.push(`section_name IN (${options.sectionNames.map(() => '?').join(',')})`); params.push(...options.sectionNames); }
  if (options.propertyType === 'land' && options.requireRoad) where.push("(road_text LIKE '%臨路%' OR CAST(tags AS CHAR) LIKE '%臨路%')");
  if (options.propertyType === 'land' && options.landShapeIds.length) {
    const names = options.landShapeIds.map(id => LAND_SHAPES[id]).filter(Boolean);
    if (names.length) { where.push(`(${names.map(() => 'CAST(tags AS CHAR) LIKE ?').join(' OR ')})`); params.push(...names.map(name => `%${name}%`)); }
  }
  const ids = [...seenIds].map(Number).filter(Number.isFinite);
  where.push(`id NOT IN (${ids.map(() => '?').join(',')})`);
  params.push(...ids);

  // Important: absence from one 591 list/BFF search is not proof of delisting.
  // 591 list results can omit a live direct listing because of ranking, category/filter quirks,
  // or page-window limits. Verify each candidate's direct detail page before marking it unavailable.
  const [candidates] = await conn.execute(`SELECT id FROM properties WHERE ${where.join(' AND ')} LIMIT 200`, params);
  let markedUnavailable = 0;
  let verifiedAvailable = 0;
  for (const row of candidates) {
    try {
      await fetchDetail(row.id, options.signal, options.propertyType);
      verifiedAvailable++;
      await conn.execute("UPDATE properties SET listing_status='active', unavailable_at=NULL, detail_error=NULL WHERE id=?", [row.id]);
    } catch (e) {
      const detailError = String(e.message || e);
      if (detailError.startsWith('detail HTTP 404') || detailError.startsWith('detail unavailable')) {
        const [result] = await conn.execute("UPDATE properties SET listing_status='unavailable', unavailable_at=COALESCE(unavailable_at, CURRENT_TIMESTAMP), detail_error=? WHERE id=?", [detailError, row.id]);
        markedUnavailable += Number(result.affectedRows || 0);
      }
    }
  }
  return { markedUnavailable, verifiedAvailable, candidates: candidates.length };
}


export async function scrapeIntoDb(conn, rawOptions = {}, onProgress = () => {}) {
  const options = normalizeOptions(rawOptions);
  options.signal = rawOptions.signal;
  let runId;
  let fetched = 0, matched = 0, detailsFetched = 0, detailErrors = 0;
  const matchedIds = new Set();
  const newIds = [];
  const startedMessage = `${PROPERTY_TYPES[options.propertyType]} 條件 price<=${options.maxPriceWan}, area>=${options.minAreaPing}, regions=${options.regions.map(r => r[1]).join(',')}, sections=${options.sectionNames.join(',') || '不限'}`;
  const [r] = await conn.query(`INSERT INTO scrape_runs(status,message) VALUES ('running', ?)`, [startedMessage]);
  runId = r.insertId;
  try {
    for (const [regionId, regionName] of options.regions) {
      let page = 1, total = 0;
      do {
        throwIfCancelled(options.signal);
        const data = await fetchPage(regionId, page, options);
        const items = data.items || [];
        total = Number(data.records || items.length || 0);
        fetched += items.length;
        for (const item of items) {
          throwIfCancelled(options.signal);
          if (isMatch(item, options)) {
            const id = houseNumericId(item);
            const { detail, detailError } = await fetchDetailForMatched(id, options.signal, options.propertyType);
            if (detail) detailsFetched++; else if (detailError) detailErrors++;
            const upsertResult = await upsert(conn, regionId, regionName, item, options, detail, detailError);
            if (upsertResult?.isNew) newIds.push(upsertResult.id);
            matchedIds.add(id);
            matched++;
          }
        }
        onProgress({ regionName, page, items: items.length, total, fetched, matched, detailsFetched, detailErrors });
        page++;
        await cancellableSleep(SEARCH.delayMs, options.signal);
      } while ((page - 1) * options.pageSize < total && page <= options.maxPagesPerRegion);
    }
    const unavailable = await markMissingMatchedRowsUnavailable(conn, options, matchedIds);
    const houseLvr = matched && options.propertyType === 'house' ? await updateLvrHouseMatches(conn, { yearsBack: 5 }) : null;
    const cp = matched ? await recomputeCpValues(conn) : { updated: 0 };
    const lvrText = houseLvr ? `，中古屋實價匹配 ${houseLvr.matched}/${houseLvr.updated}` : '';
    await conn.execute(`UPDATE scrape_runs SET finished_at=CURRENT_TIMESTAMP,status='ok',message=?,fetched_count=?,matched_count=? WHERE id=?`, [`完整詳情 ${detailsFetched}/${matched}，詳情錯誤 ${detailErrors}，候選下架 ${unavailable.candidates || 0}，確認下架 ${unavailable.markedUnavailable || 0}，仍在線 ${unavailable.verifiedAvailable || 0}${lvrText}，CP值已更新 ${cp.updated} 筆`, fetched, matched, runId]);
    return { runId, fetched, matched, detailsFetched, detailErrors, newCount: newIds.length, newIds, markedUnavailable: unavailable.markedUnavailable || 0, houseLvr, cpUpdated: cp.updated, status: 'ok' };
  } catch (err) {
    if (err.name === 'AbortError' || options.signal?.aborted) {
      await conn.execute(`UPDATE scrape_runs SET finished_at=CURRENT_TIMESTAMP,status='cancelled',message=?,fetched_count=?,matched_count=? WHERE id=?`, [String(err.message || err), fetched, matched, runId]);
      return { runId, fetched, matched, detailsFetched, detailErrors, newCount: newIds.length, newIds, status: 'cancelled', message: String(err.message || err) };
    }
    await conn.execute(`UPDATE scrape_runs SET finished_at=CURRENT_TIMESTAMP,status='error',message=?,fetched_count=?,matched_count=? WHERE id=?`, [String(err.stack || err), fetched, matched, runId]);
    throw err;
  }
}
