const decodeUnicode = s => String(s || '').replace(/\\u002F/g, '/').replace(/\\u003C/g, '<').replace(/\\u003E/g, '>').replace(/\\u0026/g, '&');
const clean = s => decodeUnicode(String(s || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p\s*>/gi, '\n')
  .replace(/<\/div\s*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'")
  .replace(/\n\s*\n+/g, '\n')
  .replace(/[ \t]+/g, ' ')
  .trim());
const between = (s, a, b) => { const i=s.indexOf(a); if(i<0)return''; const j=s.indexOf(b,i+a.length); return j<0?'':s.slice(i+a.length,j); };
const num = v => { const x = Number(String(v ?? '').replace(/,/g, '').match(/[0-9]+(?:\.[0-9]+)?/)?.[0]); return Number.isFinite(x) ? x : null; };
const infoValue = (info, group, key) => info?.[group]?.[key]?.value || '';
const textFromHtml = v => clean(String(v || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' '));

function sellerLandIntro(html) {
  const titleIdx = html.indexOf('土地介紹');
  if (titleIdx < 0) return '';
  const contentIdx = html.indexOf('class="house-condition-content"', titleIdx);
  if (contentIdx < 0) return '';
  const divStart = html.lastIndexOf('<div', contentIdx);
  if (divStart < 0) return '';
  const endMarkers = ['</div><!----><!--[--><a class="contact-action"', '<!----><!--[--><a class="contact-action"', '<div region='];
  const candidates = endMarkers.map(m => html.indexOf(m, contentIdx)).filter(i => i > contentIdx);
  const end = candidates.length ? Math.min(...candidates) : html.indexOf('</div><!---->', contentIdx + 1);
  if (end < 0) return '';
  return clean(html.slice(divStart, end));
}

function propertyValuesFromLd(html) {
  const out = {};
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(clean(m[1]));
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        const props = obj?.additionalProperty || obj?.mainEntity?.additionalProperty || [];
        for (const p of props) if (p?.name) out[String(p.name)] = String(p.value ?? '');
      }
    } catch {}
  }
  return out;
}

function fallbackValues(html) {
  const text = decodeUnicode(html);
  const keys = ['使用分區','用地類別','所有權','臨路路寬','面寬縱深','基礎設施','嫌惡設施','土地現況','地號','段名','地段'];
  const out = {};
  for (const k of keys) {
    const re = new RegExp(`"${k}"(?:,"value")?,"?([^",<]{1,80})`, 'u');
    const m = text.match(re);
    if (m) out[k] = clean(m[1]);
  }
  return out;
}


export function parseHouseDetailJson(data) {
  const ware = data?.ware || {};
  const info = data?.info || {};
  const detailJson = {};
  for (const [groupName, group] of Object.entries(info || {})) {
    if (!group || Array.isArray(group)) continue;
    for (const item of Object.values(group)) {
      if (item?.name) detailJson[String(item.name)] = textFromHtml(item.value ?? '');
    }
  }
  const remark = textFromHtml(data?.remark || ware.remark || '');
  if (remark) detailJson['屋況特色'] = remark;
  if (data?.areaTips) {
    for (const item of Object.values(data.areaTips)) if (item?.name) detailJson[String(item.name)] = textFromHtml(item.value ?? '');
  }
  const layout = infoValue(info, '1', 'Layout') || [ware.room ? `${ware.room}房` : '', ware.hall ? `${ware.hall}廳` : '', ware.toilet ? `${ware.toilet}衛` : ''].join('') || '';
  const floor = infoValue(info, '2', 'Floor') || (ware.floor || ware.allfloor ? `${ware.floor === 99 ? '整棟' : ware.floor || ''}/${ware.allfloor || ''}F` : '');
  const houseAge = infoValue(info, '1', 'HouseAge') || (ware.houseage ? `${ware.houseage}年` : '');
  const parking = infoValue(info, '3', 'CarPlace') || ware.carttype || ware.cartmodel || '';
  const houseAgeYear = num(houseAge) ?? num(ware.houseage);
  return {
    detail_json: detailJson,
    detail_description: remark,
    layout_text: layout,
    bedroom_count: ware.room ? Number(ware.room) : (num(layout?.match(/\d+房/)?.[0]) || null),
    floor_text: floor,
    parking_text: parking,
    house_age: houseAge,
    house_age_year: houseAgeYear,
    detail_fetched_at: new Date().toISOString().slice(0,19).replace('T',' ')
  };
}

export function parseDetailHtml(html) {
  const pv = { ...fallbackValues(html), ...propertyValuesFromLd(html) };
  const landIntro = sellerLandIntro(html);
  const desc = landIntro || between(html, '"description":"', '"');
  if (landIntro) pv['土地介紹'] = landIntro;
  return {
    detail_json: pv,
    detail_description: clean(desc),
    zoning: pv['使用分區'] || pv['土地現況'] || '',
    land_category: pv['用地類別'] || pv['類別'] || '',
    ownership: pv['所有權'] || '',
    land_number: pv['地號'] || '',
    frontage_depth: pv['面寬縱深'] || '',
    infrastructure: pv['基礎設施'] || '',
    disliked_facilities: pv['嫌惡設施'] || '',
    detail_fetched_at: new Date().toISOString().slice(0,19).replace('T',' ')
  };
}

export async function fetchDetail(id, signal, propertyType = 'land') {
  if (propertyType === 'house') {
    const url = `https://bff-house.591.com.tw/v1/web/sale/detail?id=${id}&timestamp=${Date.now()}&__v__=1`;
    const res = await fetch(url, { signal, headers: { 'user-agent': 'Mozilla/5.0', 'referer': 'https://sale.591.com.tw/', 'origin': 'https://sale.591.com.tw', 'device': 'pc', 'accept': 'application/json,text/plain,*/*' } });
    if (!res.ok) throw new Error(`detail HTTP ${res.status} ${id}`);
    const data = await res.json();
    if (!Number(data?.status) || !data?.data || !Object.keys(data.data).length) {
      throw new Error(`detail unavailable ${id}`);
    }
    return parseHouseDetailJson(data.data);
  }
  const res = await fetch(`https://land.591.com.tw/sale/${id}`, { signal, headers: { 'user-agent': 'Mozilla/5.0', 'referer': 'https://land.591.com.tw/' } });
  if (!res.ok) throw new Error(`detail HTTP ${res.status} ${id}`);
  return parseDetailHtml(await res.text());
}

export async function backfillDetails(db, { limit = 50, signal } = {}, onProgress = () => {}) {
  const [rows] = await db.query(`
    SELECT id, property_type FROM properties
    WHERE COALESCE(listing_status, 'active') <> 'unavailable'
      AND (detail_error IS NULL OR detail_error NOT LIKE 'detail HTTP 404%')
      AND (detail_fetched_at IS NULL
       OR (property_type='land' AND (JSON_EXTRACT(detail_json, '$."土地介紹"') IS NULL OR COALESCE(detail_description, '') = '' OR detail_description REGEXP '更多在售詳情，就上591土地'))
       OR (property_type='house' AND (JSON_EXTRACT(detail_json, '$."屋況特色"') IS NULL OR COALESCE(detail_description, '') = '' OR COALESCE(floor_text, '') = '')))
    ORDER BY updated_at DESC
    LIMIT ${Math.max(1, Math.min(500, Number(limit)||50))}
  `);
  let updated = 0;
  for (const r of rows) {
    if (signal?.aborted) throw new Error('detail backfill aborted');
    try {
      const d = await fetchDetail(r.id, signal, r.property_type === 'house' ? 'house' : 'land');
      await db.execute(`UPDATE properties SET detail_json=CAST(? AS JSON), detail_description=?, zoning=?, land_category=?, ownership=?, land_number=?, frontage_depth=?, infrastructure=?, disliked_facilities=?, layout_text=COALESCE(?, layout_text), bedroom_count=COALESCE(?, bedroom_count), floor_text=COALESCE(?, floor_text), parking_text=COALESCE(?, parking_text), house_age=COALESCE(?, house_age), house_age_year=COALESCE(?, house_age_year), detail_error=NULL, listing_status='active', unavailable_at=NULL, detail_fetched_at=? WHERE id=?`, [
        JSON.stringify(d.detail_json || {}), d.detail_description ?? null, d.zoning ?? null, d.land_category ?? null, d.ownership ?? null, d.land_number ?? null, d.frontage_depth ?? null, d.infrastructure ?? null, d.disliked_facilities ?? null, d.layout_text || null, d.bedroom_count ?? null, d.floor_text || null, d.parking_text || null, d.house_age || null, d.house_age_year ?? null, d.detail_fetched_at, r.id
      ]);
      updated++;
      onProgress({ updated, id: r.id });
      await new Promise(r => setTimeout(r, 350));
    } catch (e) {
      const message = String(e.message || e);
      if (message.startsWith('detail HTTP 404')) {
        await db.execute("UPDATE properties SET detail_error=?, listing_status='unavailable', unavailable_at=COALESCE(unavailable_at, CURRENT_TIMESTAMP), detail_fetched_at=CURRENT_TIMESTAMP WHERE id=?", [message, r.id]);
      }
      onProgress({ updated, id: r.id, error: message });
    }
  }
  return { updated, total: rows.length };
}
