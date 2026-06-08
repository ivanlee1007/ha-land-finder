const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const median = values => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const percentileLowerIsBetter = (value, values) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length || !Number.isFinite(value)) return 0.5;
  const lowerOrEqual = a.filter(x => x <= value).length;
  return lowerOrEqual / a.length;
};
const toText = row => [row.title, row.address, row.section_name, row.segment_name, row.road_text, row.zoning, row.land_category, row.ownership, row.frontage_depth, row.infrastructure, row.disliked_facilities, row.layout_text, row.community_name, row.floor_text, row.parking_text, row.house_age, row.detail_description, JSON.stringify(row.tags || []), JSON.stringify(row.raw || {}), JSON.stringify(row.detail_json || {})].join(' ');
const tagList = row => Array.isArray(row.tags) ? row.tags.map(String) : [];
const isHouse = row => String(row.property_type || '') === 'house';
const hasAny = (text, words) => words.some(w => text.includes(w));

function primaryLandType(row) {
  const tags = tagList(row).join(' ');
  if (isHouse(row)) return row.sale_kind || '中古屋';
  for (const t of ['農地', '建地', '住宅用地', '商業用地', '工業用地', '林地', '山坡地', '道路用地']) {
    if (tags.includes(t)) return t;
  }
  return '其他';
}

function roadWidth(row) {
  const m = String(row.road_text || '').match(/(\d+(?:\.\d+)?)\s*米/);
  return m ? Number(m[1]) : null;
}

function sizeScore(row, landType) {
  const area = Number(row.area_ping || 0);
  if (!area) return { score: 3, note: '坪數資料不足' };
  if (isHouse(row)) {
    if (area >= 20 && area <= 45) return { score: 10, note: '中古屋坪數落在常見好流通帶' };
    if (area > 45 && area <= 80) return { score: 8, note: '中古屋坪數較大，適合家庭使用' };
    return { score: 6, note: '坪數規模較吃買方需求' };
  }
  if (landType === '農地') {
    if (area >= 756 && area <= 1800) return { score: 10, note: '農地面積落在常見好流通帶' };
    if (area > 1800 && area <= 3500) return { score: 8, note: '農地面積較大，適合整體規劃' };
    if (area > 3500) return { score: 6, note: '坪數很大，總價與轉手族群較受限' };
    return { score: 5, note: '農地面積低於 756 坪門檻' };
  }
  if (landType.includes('建') || landType.includes('住宅') || landType.includes('商業')) {
    if (area >= 30 && area <= 300) return { score: 10, note: '建築用地坪數較好規劃與流通' };
    if (area > 300 && area <= 1000) return { score: 8, note: '建築用地坪數較大，開發彈性高' };
    return { score: 6, note: '坪數規模較吃買方需求' };
  }
  return { score: clamp(5 + Math.log10(area) * 2, 4, 9), note: '坪數條件一般' };
}

function hasPositiveInfra(text) {
  if (hasAny(text, ['暫無水電', '無水電', '無水', '無電', '無自來水'])) return false;
  return hasAny(text, ['水電', '有水', '有電', '自來水', '電力', '通路']);
}

function conditionScore(row) {
  const text = toText(row);
  const w = roadWidth(row);
  let score = 0;
  const notes = [];
  if (isHouse(row)) {
    score += 8;
    notes.push(row.layout_text ? `格局 ${row.layout_text}` : '中古屋基本資訊');
    if (row.community_name) { score += 3; notes.push(`社區 ${row.community_name}`); }
    if (row.parking_text) { score += 3; notes.push(`車位 ${row.parking_text}`); }
    const age=Number(row.house_age_year); if(Number.isFinite(age)&&age>0){ if(age<=10){score+=3; notes.push(`屋齡約 ${age} 年`)} else if(age>35){score-=2; notes.push(`屋齡約 ${age} 年，需留意修繕`)}}
  } else if (text.includes('臨路') || Number(row.road_width_m) > 0) {
    const ww = Number(row.road_width_m) || w;
    const roadPts = ww == null ? 8 : ww >= 6 ? 13 : ww >= 4 ? 11 : ww >= 2 ? 8 : 5;
    score += roadPts;
    notes.push(ww ? `臨路約 ${ww} 米` : '有臨路');
  } else {
    notes.push('臨路條件未明');
  }
  if (!isHouse(row) && hasPositiveInfra(text)) { score += 5; notes.push('水電/基礎設施加分'); }
  if (hasAny(text, ['可蓋農舍', '農舍'])) { score += 4; notes.push('具農舍題材'); }
  if (row.is_below_stand) { score += 4; notes.push('591標示低於行情'); }
  if (Number(row.price_reduction_wan) > 0) { score += 2; notes.push(`曾降價 ${Number(row.price_reduction_wan)} 萬`); }
  if (row.has_video) { score += 1; notes.push('有影片資訊較完整'); }
  if (hasAny(text, ['一般農', '特農', '農牧用地'])) { score += 2; notes.push('農地使用類別明確'); }
  if (hasAny(text, ['都計內', '都市土地'])) { score += 3; notes.push('都計內/都市土地題材'); }
  if (hasAny(text, ['民有土地', '所有權'])) { score += 1; notes.push('權屬資訊明確'); }
  if (hasAny(text, ['方正', '平坦', '平整'])) { score += 2; notes.push('地形描述佳'); }
  return { score: clamp(score, 0, 25), notes };
}

function riskPenalty(row) {
  const text = toText(row);
  const risks = [
    ['持分', 14, '持分產權風險'], ['共有', 8, '共有產權需留意'], ['袋地', 10, '出入通行風險'],
    ['山坡', 8, '山坡地開發限制'], ['保護區', 9, '使用分區限制'], ['墳', 6, '嫌惡因素'],
    ['墓', 6, '嫌惡因素'], ['嫌惡設施', 4, '嫌惡設施需確認'], ['道路用地', 7, '道路用地用途受限'], ['套繪', 10, '套繪/建築限制風險'],
    ['未保存', 5, '建物權狀風險'], ['無路', 12, '無路地風險'], ['凶宅', 18, '凶宅風險'], ['事故', 12, '事故屋需留意']
  ];
  let penalty = 0;
  const notes = [];
  for (const [kw, p, note] of risks) {
    if (text.includes(kw)) { penalty += p; if (!notes.includes(note)) notes.push(note); }
  }
  if (row.is_high_value) { penalty += 4; notes.push('591標示高價物件'); }
  return { penalty: clamp(penalty, 0, 25), notes };
}

function peerKey(row, level) {
  const type = primaryLandType(row);
  if (level === 0) return `${row.region_id}|${row.section_name || ''}|${type}`;
  if (level === 1) return `${row.region_id}|${type}`;
  return `ALL|${type}`;
}

function buildPeerStats(rows) {
  const groups = [{}, {}, {}];
  for (const row of rows) {
    const unit = Number(row.price_wan) / Number(row.area_ping);
    if (!Number.isFinite(unit) || unit <= 0) continue;
    for (let level = 0; level < 3; level++) {
      const key = peerKey(row, level);
      groups[level][key] ||= { units: [], prices: [] };
      groups[level][key].units.push(unit);
      groups[level][key].prices.push(Number(row.price_wan));
    }
  }
  return groups;
}

function choosePeer(row, groups) {
  for (let level = 0; level < 3; level++) {
    const g = groups[level][peerKey(row, level)];
    if (g && g.units.length >= (level === 0 ? 3 : 5)) return { ...g, level };
  }
  return groups[2][peerKey(row, 2)] || { units: [], prices: [], level: 2 };
}

export function cpForRow(row, groups) {
  const price = Number(row.price_wan);
  const area = Number(row.area_ping);
  const unit = price / area;
  const landType = primaryLandType(row);
  if (!Number.isFinite(price) || !Number.isFinite(area) || !Number.isFinite(unit) || price <= 0 || area <= 0) {
    return { score: null, note: '價格或坪數資料不足，暫不評分' };
  }
  const peer = choosePeer(row, groups);
  const listedMedUnit = median(peer.units) || unit;
  const lvrMedUnit = Number(row.lvr_median_unit_wan);
  const hasLvr = Number.isFinite(lvrMedUnit) && lvrMedUnit > 0 && Number(row.lvr_sample_count || 0) > 0;
  const medUnit = hasLvr ? lvrMedUnit : listedMedUnit;
  const medPrice = median(peer.prices) || price;
  const unitRatio = unit / medUnit;
  const unitScore = hasLvr
    ? clamp(30 + (1 - unitRatio) * 90, 0, 52)
    : clamp(24 + (1 - unitRatio) * 80, 0, 45);
  const pricePct = percentileLowerIsBetter(price, peer.prices);
  const liquidityScore = clamp(10 * (1 - pricePct) + 2, 0, 10);
  const sz = sizeScore(row, landType);
  const cond = conditionScore(row);
  const risk = riskPenalty(row);
  const dataQuality = hasLvr ? (Number(row.lvr_sample_count) >= 12 ? 8 : Number(row.lvr_sample_count) >= 5 ? 6 : 4) : (peer.units.length >= 8 ? 5 : peer.units.length >= 3 ? 3 : 1);
  const userScoreRaw = Number(row.user_score || 0);
  const userScore = Number.isFinite(userScoreRaw) ? clamp(userScoreRaw, -30, 30) : 0;
  const score = clamp(unitScore + liquidityScore + sz.score + cond.score + dataQuality + userScore - risk.penalty, 0, 100);
  const notes = [];
  const lvrLabelMap = { segment: '同地段實價', section: '同行政區實價', region: '同縣市實價' };
  const peerLabel = hasLvr ? (isHouse(row) ? ({section:'同行政區實價',region:'同縣市實價'}[row.lvr_match_level] || '中古屋實價登錄') : (lvrLabelMap[row.lvr_match_level] || '實價登錄')) : (peer.level === 0 ? '同區591掛牌' : peer.level === 1 ? '同縣市591掛牌' : '全資料591掛牌');
  if (hasLvr) notes.push(`${peerLabel}${row.lvr_recent_years ? `(${row.lvr_recent_years})` : ''}樣本 ${Number(row.lvr_sample_count)} 筆，中位約 ${lvrMedUnit.toFixed(2)}萬/坪`);
  if (unitRatio <= 0.8) notes.push(`單價低於${peerLabel}中位約 ${Math.round((1 - unitRatio) * 100)}%`);
  else if (unitRatio <= 1.05) notes.push(`單價接近${peerLabel}行情`);
  else notes.push(`單價高於${peerLabel}中位約 ${Math.round((unitRatio - 1) * 100)}%`);
  if (price <= medPrice) notes.push('總價低於同類中位，流動性較佳');
  if (userScore) notes.push(`使用者評分 ${userScore > 0 ? '+' : ''}${userScore} 分已納入CP`);
  notes.push(sz.note);
  notes.push(...cond.notes.slice(0, 3));
  if (risk.notes.length) notes.push(...risk.notes.slice(0, 2));
  notes.push(hasLvr ? (isHouse(row) ? `模型：中古屋實價登錄成交比較為主，輔以591掛牌/格局/車位/屋齡/面積/風險調整` : `模型：實價登錄成交比較為主，輔以591掛牌/臨路/水電/用途/面積/風險調整`) : (isHouse(row) ? `模型：591中古屋掛牌市場比較為主，輔以格局/車位/屋齡/面積/風險調整` : `模型：591掛牌市場比較為主，輔以臨路/水電/用途/面積/風險調整`));
  return { score: Math.round(score * 10) / 10, note: notes.slice(0, 6).join('；') };
}

export async function recomputeCpValues(db) {
  const [rows] = await db.query('SELECT id,region_id,region_name,property_type,sale_kind,layout_text,bedroom_count,community_name,floor_text,parking_text,house_age,house_age_year,title,price_wan,area_ping,unit_price,address,section_name,segment_name,road_text,road_width_m,ground_type,price_reduction_wan,browsenum_all,has_video,is_below_stand,is_high_value,zoning,land_category,ownership,frontage_depth,infrastructure,disliked_facilities,detail_description,detail_json,tags,raw,lvr_match_level,lvr_sample_count,lvr_median_unit_wan,lvr_recent_years,user_score FROM properties');
  const groups = buildPeerStats(rows);
  let updated = 0;
  for (const row of rows) {
    const cp = cpForRow(row, groups);
    await db.execute('UPDATE properties SET cp_score=?, cp_note=?, cp_updated_at=CURRENT_TIMESTAMP WHERE id=?', [cp.score, cp.note, row.id]);
    updated++;
  }
  return { updated };
}
