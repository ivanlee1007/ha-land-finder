import { pool, ensureSchema } from './db.js';
import { recomputeCpValues } from './valuation.js';
import { updateLvrMatches } from './lvr-stats.js';
import { updateLvrHouseMatches } from './lvr-house-stats.js';
import { REGIONS } from './config.js';

const SOURCE_REGION_CODES = {
  1: '021', 2: '024', 3: '022', 4: '035', 5: '036', 6: '034', 7: '037', 8: '042',
  10: '047', 11: '049', 12: '053', 13: '052', 14: '055', 15: '062', 17: '072', 19: '087'
};
const REGION_CODES = Object.fromEntries(REGIONS.map(([id, name]) => [id, { id, name, code: SOURCE_REGION_CODES[id] }]).filter(([, r]) => r.code));
const DEFAULT_REGION = REGION_CODES[15];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s ?? '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p\s*>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();
const num = v => {
  const m = String(v ?? '').replace(/,/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
  return m ? Number(m[0]) : null;
};
const hashId = key => {
  let h = 1469598103934665603n;
  for (const ch of key) { h ^= BigInt(ch.codePointAt(0)); h *= 1099511628211n; }
  return Number(h % 9000000000000n) + 8000000000000;
};
const fieldAfter = (text, key, nextKeys) => {
  const i = text.indexOf(key);
  if (i < 0) return '';
  let j = text.length;
  for (const n of nextKeys) {
    if (n === key) continue;
    const k = text.indexOf(n, i + key.length);
    if (k > i && k < j) j = k;
  }
  return text.slice(i + key.length, j).replace(/^[:：]/, '').trim();
};
const absUrl = (base, href) => new URL(href, base).href;
const asNum = (v, fallback) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; };
const sourceName = v => ({ yes319: 'yes319', land319: 'land319' }[v] || v);
function queryText(criteria = {}) {
  const parts = [String(criteria.q || '').trim()].filter(Boolean);
  if (criteria.propertyType === 'house') {
    const bedrooms = Array.isArray(criteria.bedroomCounts) ? criteria.bedroomCounts.map(Number).filter(Number.isFinite) : [];
    if (bedrooms.length === 1) parts.push(`${bedrooms[0]}房`);
    if (criteria.parkingRequired) parts.push('車位');
    const floorText = { low: '低樓層', mid: '中樓層', high: '高樓層', top: '頂樓', not_top: '' }[criteria.floorLevel] || '';
    if (floorText) parts.push(floorText);
  }
  return [...new Set(parts)].join(' ');
}
function buildSearchUrl(sourceSite, region, criteria = {}) {
  const propertyType = criteria.propertyType === 'house' ? 'house' : 'land';
  const maxPrice = asNum(criteria.maxPriceWan, propertyType === 'land' ? 360 : 1000);
  const minArea = asNum(criteria.minAreaPing, propertyType === 'land' ? 756 : 30);
  const p = new URLSearchParams({ A01: region.code, D01: '0', D02: String(maxPrice), E01: String(minArea), E02: '0', qs: queryText(criteria) });
  if (sourceSite === 'land319') {
    p.append('C01[]', propertyType === 'land' && Array.isArray(criteria.landShapeIds) && criteria.landShapeIds.includes('4') ? '0' : '1');
    return `https://www.land319.com/${region.code}/search.php?${p.toString()}`;
  }
  // yes319 confirmed: A01 city, D01/D02 price, E01/E02 area, qs keyword. House-specific controls are added to qs when possible and then strictly filtered locally below.
  return `https://www.yes319.com/${region.code}/search.php?${p.toString()}`;
}
function floorMatches(text, level) {
  if (!level) return true;
  if (level === 'top') return /頂樓/.test(text);
  if (level === 'not_top') return !/頂樓/.test(text);
  if (level === 'high') return /高樓|高樓層/.test(text);
  if (level === 'mid') return /中樓|中樓層/.test(text);
  if (level === 'low') return /低樓|低樓層|整棟|透天|(?:^|[^0-9])(?:1|2|3)F|(?:^|[^0-9])(?:1|2|3)樓/.test(text);
  return true;
}
function matchesCriteria(x, criteria = {}) {
  if (criteria.propertyType && x.propertyType !== criteria.propertyType) return false;
  if (Array.isArray(criteria.sectionNames) && criteria.sectionNames.length && !criteria.sectionNames.includes(x.section)) return false;
  const maxPrice = Number(criteria.maxPriceWan); if (Number.isFinite(maxPrice) && maxPrice > 0 && Number(x.price || 0) > maxPrice) return false;
  const minArea = Number(criteria.minAreaPing); if (Number.isFinite(minArea) && minArea > 0 && Number(x.area || 0) < minArea) return false;
  if (x.propertyType === 'house') {
    const bedrooms = Array.isArray(criteria.bedroomCounts) ? criteria.bedroomCounts.map(Number).filter(Number.isFinite) : [];
    if (bedrooms.length) {
      const n = Number(x.bedroomCount || num(x.layoutText?.match(/\d+房/)?.[0]));
      if (!Number.isFinite(n) || !bedrooms.some(b => b >= 5 ? n >= 5 : n === b)) return false;
    }
    const maxAge = Number(criteria.maxHouseAgeYear);
    if (Number.isFinite(maxAge) && maxAge >= 0 && Number.isFinite(Number(x.houseAgeYear)) && Number(x.houseAgeYear) > maxAge) return false;
    if (criteria.parkingRequired && !/(車位|平車|車庫|坡道|機械|平面|併排)/.test(String(x.parkingText || '') + ' ' + String(x.title || ''))) return false;
    if (!floorMatches(`${x.floorText || ''} ${x.title || ''}`, criteria.floorLevel)) return false;
  }
  return true;
}
function buildJobs(criteria = {}) {
  const requested = String(criteria.sourceSite || '');
  const propertyType = criteria.propertyType === 'house' ? 'house' : 'land';
  const regionIds = Array.isArray(criteria.regionIds) && criteria.regionIds.length ? criteria.regionIds.map(Number) : [15];
  const regions = regionIds.map(id => REGION_CODES[id]).filter(Boolean);
  const unsupported = regionIds.filter(id => !REGION_CODES[id]);
  const wantedSources = requested ? [requested] : (propertyType === 'house' ? ['yes319'] : ['land319']);
  const jobs = [];
  for (const region of regions) {
    for (const sourceSite of wantedSources) {
      if (!['yes319','land319'].includes(sourceSite)) continue;
      if (sourceSite === 'land319' && propertyType === 'house') continue;
      jobs.push({ sourceSite, region, url: buildSearchUrl(sourceSite, region, criteria) });
    }
  }
  return { jobs, unsupported };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const html = await res.text();
  if (/iyudigi\.com\/block-page|name=["']transferForm["'][^>]+block-page/i.test(html)) {
    throw new Error(`外站防護頁阻擋：${url}`);
  }
  return html;
}

function parseList(html, baseUrl, sourceSite, region = DEFAULT_REGION) {
  const out = [];
  const re = /<a[^>]+href=["']([^"']*showobj\.php\?objno=([^"'&]+)[^"']*)["'][\s\S]*?<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const block = m[0];
    if (!/<img/i.test(block) || !/obj-|obj_/.test(block)) continue;
    const titleAttr = block.match(/title=["']([^"']+)["']/i)?.[1] || '';
    const img = block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || '';
    const text = clean(block);
    const sourceId = m[2];
    const propertyType = sourceId.startsWith('b') || sourceSite === 'land319' ? 'land' : 'house';
    const title = (block.match(/itemprop=["']title["'][^>]*>([^<]+)/i)?.[1]
      || block.match(/<span[^>]*>([^<]{2,120})<\/span>/i)?.[1]
      || titleAttr.split('|')[0]?.replace(/^[^-]+-/, '') || '').trim();
    const dataLine = (block.match(/itemprop=["']Area\/category["'][^>]*>([^<]+)/i)?.[1]
      || block.match(/<div[^>]*class=["']item-data["'][\s\S]*?<div>([\s\S]*?)<\/div>/i)?.[1]
      || '').trim();
    const priceText = block.match(/<div[^>]*class=["'][^"']*obj-money[^"']*["'][\s\S]*?<\/div>/i)?.[0] || text;
    const parts = clean(dataLine).split(/\s+/).filter(Boolean);
    const section = parts[0] || '';
    const saleKind = parts[1] || (propertyType === 'land' ? '土地' : '住宅');
    const area = num(parts.find(x => x.includes('坪')) || titleAttr.match(/(?:權狀坪數|地坪):?([^|]+)/)?.[1]);
    const price = num(clean(priceText).match(/[0-9,]+(?:\.[0-9]+)?\s*萬/)?.[0]);
    out.push({ sourceSite, sourceId, sourceKey: `${sourceSite}:${sourceId}`, id: hashId(`${sourceSite}:${sourceId}`), region, propertyType, title, section, saleKind, area, price, photoUrl: img ? absUrl(baseUrl, img) : '', url: absUrl(baseUrl, m[1]), titleAttr, rawListText: text });
  }
  const seen = new Set();
  return out.filter(x => x.sourceId && x.title && !seen.has(x.sourceKey) && seen.add(x.sourceKey));
}

function parseKeyValuesFromDetail(html) {
  const kv = {};
  for (const m of html.matchAll(/<div class=["']column-title[^"']*["']>([\s\S]*?)<\/div>\s*<div class=["']column-data[^"']*["']>([\s\S]*?)<\/div>/gi)) {
    const k = clean(m[1]);
    const v = clean(m[2]);
    if (k && v) kv[k] = v;
  }
  for (const m of html.matchAll(/<div class=["']column-title-obj[^"']*["']>([\s\S]*?)<\/div>\s*<div class=["']column-data-obj[^"']*["']>([\s\S]*?)<\/div>/gi)) {
    const k = clean(m[1]);
    const v = clean(m[2]);
    if (k && v && !kv[k]) kv[k] = v;
  }
  return kv;
}

function parseFeature(html) {
  const idx = html.indexOf('>特色<');
  if (idx < 0) return '';
  const endCandidates = ['<div class="detail-box-zone">', '<div class="text-center font_02"', '<div class="col-12 interval box-4"'];
  let end = html.length;
  for (const marker of endCandidates) {
    const k = html.indexOf(marker, idx + 20);
    if (k > idx && k < end) end = k;
  }
  return clean(html.slice(idx, end)).replace(/^(?:>\s*)?(?:特色\s*)+/u, '').trim();
}

async function detailFor(item) {
  const html = await fetchText(item.url);
  const kv = parseKeyValuesFromDetail(html);
  const text = clean(html);
  const title = html.match(/<span class=['"]h4 m-0['"]>([\s\S]*?)<\/span>/i)?.[1];
  const feature = parseFeature(html) || fieldAfter(text, '特色', ['其他', '服務人員資料', '附近實價登錄']).replace(/^特色\s*/, '');
  if (item.propertyType === 'house') {
    const layout = kv['格局'] || fieldAfter(text, '格局', ['屋齡','樓層','朝向','地址']);
    const age = kv['屋齡'] || fieldAfter(text, '屋齡', ['樓層','朝向','地址']);
    const floor = kv['樓層樓高'] || kv['樓層'] || fieldAfter(text, '樓層', ['朝向','地址']);
    const parking = kv['車位'] || fieldAfter(text, '車位', ['坪數','生活機能','特色']);
    return {
      ...item,
      title: clean(title) || item.title,
      price: num(fieldAfter(text, '總價', ['坪單價','權狀坪數'])) || item.price,
      area: num(kv['權狀坪數'] || fieldAfter(text, '權狀坪數', ['格局','屋齡','樓層'])) || item.area,
      unitPrice: kv['坪單價'] || (fieldAfter(text, '坪單價', ['權狀坪數','格局']) || ''),
      address: (kv['地址'] || fieldAfter(text, '地址', ['明山房屋','姓名:','品牌:','預約看屋'])).replace(/Google地圖定位.*$/, '').trim(),
      saleKind: kv['房屋類型'] || item.saleKind,
      layoutText: layout,
      bedroomCount: num(layout?.match(/\d+房/)?.[0]),
      floorText: floor,
      parkingText: parking,
      houseAge: age,
      houseAgeYear: num(age),
      detailDescription: feature,
      detailJson: kv,
      tags: ['yes319', item.saleKind].filter(Boolean),
      raw: { list: item, detail: kv }
    };
  }
  return {
    ...item,
    title: clean(title) || item.title,
    price: num(fieldAfter(text, '總價', ['坪單價','位置'])) || item.price,
    area: num(kv['坪數'] || fieldAfter(text, '坪數', ['類型','地號'])) || item.area,
    unitPrice: kv['坪單價'] || fieldAfter(text, '坪單價', ['位置','坪數']) || '',
    address: kv['位置'] || fieldAfter(text, '位置', ['坪數','類型']),
    saleKind: kv['類型'] || item.saleKind,
    landNumber: kv['地號'] || fieldAfter(text, '地號', ['分割出售','面前道路']),
    roadText: kv['面前道路'] || fieldAfter(text, '面前道路', ['其他','點閱次數','相關標籤']),
    detailDescription: feature,
    detailJson: kv,
    tags: ['land319', kv['類型'] || item.saleKind].filter(Boolean),
    raw: { list: item, detail: kv }
  };
}

async function upsert(db, x) {
  await db.execute(`
    INSERT INTO properties
      (id, source_site, source_id, source_key, houseid, region_id, region_name, property_type, sale_kind, title, price_wan, area_ping, unit_price,
       layout_text, bedroom_count, floor_text, parking_text, house_age, house_age_year, address, section_name, segment_name, road_text,
       land_number, detail_description, detail_json, tags, photo_url, url, raw, detail_fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, CAST(? AS JSON), CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      source_site=VALUES(source_site), source_id=VALUES(source_id), source_key=VALUES(source_key), houseid=VALUES(houseid), region_id=VALUES(region_id), region_name=VALUES(region_name), property_type=VALUES(property_type), sale_kind=VALUES(sale_kind),
      title=IF(is_favorite=1,title,VALUES(title)), price_wan=IF(is_favorite=1,price_wan,VALUES(price_wan)), area_ping=IF(is_favorite=1,area_ping,VALUES(area_ping)), unit_price=VALUES(unit_price),
      layout_text=COALESCE(VALUES(layout_text), layout_text), bedroom_count=COALESCE(VALUES(bedroom_count), bedroom_count), floor_text=COALESCE(VALUES(floor_text), floor_text), parking_text=COALESCE(VALUES(parking_text), parking_text), house_age=COALESCE(VALUES(house_age), house_age), house_age_year=COALESCE(VALUES(house_age_year), house_age_year),
      address=IF(is_favorite=1,address,VALUES(address)), section_name=VALUES(section_name), segment_name=COALESCE(VALUES(segment_name), segment_name), road_text=COALESCE(VALUES(road_text), road_text), land_number=COALESCE(VALUES(land_number), land_number),
      detail_description=COALESCE(VALUES(detail_description), detail_description), detail_json=VALUES(detail_json), tags=VALUES(tags), photo_url=VALUES(photo_url), url=VALUES(url), raw=VALUES(raw), detail_error=NULL, detail_fetched_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
  `, [
    x.id, x.sourceSite, x.sourceId, x.sourceKey, x.sourceId, (x.region || DEFAULT_REGION).id, (x.region || DEFAULT_REGION).name, x.propertyType, x.saleKind || null, x.title || '', x.price ?? null, x.area ?? null, x.unitPrice || '',
    x.layoutText || null, x.bedroomCount ?? null, x.floorText || null, x.parkingText || null, x.houseAge || null, x.houseAgeYear ?? null, x.address || '', x.section || '', x.segment || null, x.roadText || null,
    x.landNumber || null, x.detailDescription || null, JSON.stringify(x.detailJson || {}), JSON.stringify(x.tags || []), x.photoUrl || '', x.url, JSON.stringify(x.raw || {})
  ]);
}

export async function scrapeYes319Mvp(db, { detailLimit = 12, criteria = {} } = {}, onProgress = () => {}) {
  const { jobs, unsupported } = buildJobs(criteria);
  const summary = [];
  for (const job of jobs) {
    let html, list;
    try {
      html = await fetchText(job.url);
      list = parseList(html, job.url, job.sourceSite, job.region).slice(0, detailLimit);
    } catch (e) {
      const error = String(e.message || e);
      onProgress({ sourceSite: job.sourceSite, regionName: job.region.name, error, url: job.url });
      summary.push({ sourceSite: job.sourceSite, regionName: job.region.name, listed: 0, imported: 0, url: job.url, error });
      continue;
    }
    let imported = 0;
    for (const item of list) {
      try {
        const detail = await detailFor(item);
        if (!matchesCriteria(detail, criteria)) {
          onProgress({ sourceSite: job.sourceSite, regionName: job.region.name, skipped: true, id: item.sourceId, title: detail.title });
          continue;
        }
        await upsert(db, detail);
        imported++;
        onProgress({ sourceSite: job.sourceSite, regionName: job.region.name, imported, id: item.sourceId, title: detail.title });
        await sleep(500);
      } catch (e) {
        onProgress({ sourceSite: job.sourceSite, regionName: job.region.name, error: String(e.message || e), id: item.sourceId });
      }
    }
    summary.push({ sourceSite: job.sourceSite, regionName: job.region.name, listed: list.length, imported, url: job.url });
  }
  await updateLvrMatches(db, { yearsBack: 5 });
  await updateLvrHouseMatches(db, { yearsBack: 5 });
  const cp = await recomputeCpValues(db);
  return { ok: true, summary, unsupportedRegions: unsupported, criteria, cp };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await pool();
  await ensureSchema(db);
  const result = await scrapeYes319Mvp(db, { detailLimit: Number(process.env.YES319_MVP_LIMIT || 12), criteria: { propertyType: process.env.PROPERTY_TYPE || 'land', sourceSite: process.env.SOURCE_SITE || '', regionIds: process.env.REGION_IDS ? process.env.REGION_IDS.split(',').map(Number) : [15], maxPriceWan: process.env.MAX_PRICE_WAN, minAreaPing: process.env.MIN_AREA_PING, q: process.env.Q || '', bedroomCounts: process.env.BEDROOMS ? process.env.BEDROOMS.split(',').map(Number) : [], maxHouseAgeYear: process.env.MAX_HOUSE_AGE, parkingRequired: process.env.PARKING === '1', floorLevel: process.env.FLOOR || '' } }, p => console.log(JSON.stringify(p)));
  console.log(JSON.stringify(result, null, 2));
  await db.end();
}
