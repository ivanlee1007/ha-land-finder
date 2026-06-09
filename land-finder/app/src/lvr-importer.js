import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { ensureSchema, pool } from './db.js';

const DOWNLOAD_BASE = 'https://plvr.land.moi.gov.tw';
const COUNTY_BY_CODE = {
  a: ['台北市', null], b: ['台中市', 8], c: ['基隆市', 2], d: ['台南市', 15], e: ['高雄市', 17],
  f: ['新北市', 3], g: ['宜蘭縣', 21], h: ['桃園市', 6], i: ['嘉義市', 12], j: ['新竹縣', 5],
  k: ['苗栗縣', 7], m: ['南投縣', 11], n: ['彰化縣', 10], o: ['新竹市', 4], p: ['雲林縣', 14],
  q: ['嘉義縣', 13], t: ['屏東縣', 19], u: ['花蓮縣', 23], v: ['台東縣', 22], w: ['金門縣', null], x: ['澎湖縣', 24]
};
const WEST_CODES = ['b','d','e','f','g','h','i','j','k','m','n','o','p','q','t','u','v'];
const DEFAULT_SEASONS = ['115S1','114S4','114S3','114S2','114S1','113S4','113S3','113S2','113S1','112S4','112S3','112S2','112S1'];
const PING_PER_SQM = 0.3025;

export function countyCodesForRegionIds(regionIds = []) {
  const wanted = new Set((Array.isArray(regionIds) ? regionIds : []).map(Number).filter(Number.isFinite));
  if (!wanted.size) return WEST_CODES;
  return Object.entries(COUNTY_BY_CODE)
    .filter(([, [, regionId]]) => regionId && wanted.has(Number(regionId)))
    .map(([code]) => code);
}

function csvParse(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
function toObjects(text) {
  const rows = csvParse(text).filter(r => r.some(v => String(v || '').trim()));
  const header = (rows[0] || []).map((h, i) => i === 0 ? String(h).replace(/^\uFEFF/, '') : h);
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
function n(v) { const x = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(x) ? x : null; }
function yearFromRocDate(v) {
  const s = String(v || '').trim();
  if (s.length < 3) return null;
  const roc = Number(s.slice(0, -4));
  return Number.isFinite(roc) ? roc + 1911 : null;
}
function segmentFromPosition(v) {
  const s = String(v || '').trim();
  const m = s.match(/([^\s,，、]+?段)(?:[^段]|$)/);
  return m ? m[1] : null;
}
function landUseFrom(row, landParts) {
  const main = [row['都市土地使用分區'], row['非都市土地使用分區'], row['非都市土地使用編定']].filter(Boolean).join('；');
  const parts = [...new Set(landParts.map(x => x['使用分區或編定']).filter(Boolean))];
  return parts.length ? parts.join('；') : main;
}
function isLikelyLand(row) {
  const t = row['交易標的'] || '';
  const buildingArea = n(row['建物移轉總面積平方公尺']) || 0;
  return t.includes('土地') && buildingArea === 0;
}
function isLikelyHouse(row) {
  const t = row['交易標的'] || '';
  const buildingArea = n(row['建物移轉總面積平方公尺']) || 0;
  const price = n(row['總價元']) || 0;
  return t.includes('房地') && buildingArea >= 10 && price > 0;
}
function houseLayout(row) {
  return ['房','廳','衛'].map(k => row[k] ? `${row[k]}${k}` : '').join('') || '';
}
function houseParking(row) {
  return [row['車位類別'], row['車位移轉總面積平方公尺'] ? `${row['車位移轉總面積平方公尺']}㎡` : ''].filter(Boolean).join(' ');
}
function isUsefulHouseComp(row) {
  const note = row['備註'] || '';
  if (/親友|員工|共有人|特殊關係|持分買賣|持分移轉|二親等|債務|讓與|法院|拍賣|急買急賣|瑕疵/.test(note)) return false;
  return isLikelyHouse(row);
}
function isUsefulMarketComp(row, landUse, landParts) {
  const note = row['備註'] || '';
  const transfer = landParts.map(x => x['移轉情形'] || '').join(' ');
  if (/親友|員工|共有人|特殊關係|持分買賣|持分移轉|二親等|債務|讓與|法院|拍賣|急買急賣|瑕疵|未登記建物/.test(note + transfer)) return false;
  const area = n(row['土地移轉總面積平方公尺']) || 0;
  const price = n(row['總價元']) || 0;
  if (area < 50 || price <= 0) return false;
  if (/道路用地|水利用地|交通用地|墓|墳/.test(landUse)) return false;
  return true;
}
async function download(url, dest) {
  const res = await fetch(url, { headers: { 'user-agent': 'OpenClaw land591 local valuation tool' } });
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}
async function listZipNames(zipPath) {
  const out = await new Promise((resolve, reject) => {
    const cp = zlib.createUnzip();
    reject(new Error('not implemented'));
  }).catch(() => null);
  return out;
}
async function extractZip(zipPath, outDir) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  // Use Python stdlib zipfile to avoid relying on system unzip.
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const py = spawn('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zipPath, outDir], { stdio: 'inherit' });
    py.on('exit', code => code === 0 ? resolve() : reject(new Error(`python unzip exited ${code}`)));
  });
}
async function importSeason(db, season, { countyCodes = WEST_CODES, tmpRoot = path.join(os.tmpdir(), 'land591-lvr') } = {}) {
  await fs.mkdir(tmpRoot, { recursive: true });
  const zipPath = path.join(tmpRoot, `${season}.zip`);
  const url = `${DOWNLOAD_BASE}/DownloadSeason?season=${encodeURIComponent(season)}&type=zip&fileName=lvr_landcsv.zip`;
  try { await fs.access(zipPath); } catch { await download(url, zipPath); }
  const outDir = path.join(tmpRoot, season);
  await extractZip(zipPath, outDir);
  let imported = 0, houseImported = 0, skipped = 0;
  for (const code of countyCodes) {
    const meta = COUNTY_BY_CODE[code];
    if (!meta) continue;
    const [regionName, regionId] = meta;
    const mainPath = path.join(outDir, `${code}_lvr_land_a.csv`);
    const landPath = path.join(outDir, `${code}_lvr_land_a_land.csv`);
    try { await fs.access(mainPath); } catch { continue; }
    const mainRows = toObjects(await fs.readFile(mainPath, 'utf8'));
    const landRows = await fs.readFile(landPath, 'utf8').then(toObjects).catch(() => []);
    const landBySerial = new Map();
    for (const r of landRows) {
      const k = r['編號'];
      if (!k) continue;
      if (!landBySerial.has(k)) landBySerial.set(k, []);
      landBySerial.get(k).push(r);
    }
    const batch = [];
    const houseBatch = [];
    for (const row of mainRows) {
      const serial = row['編號'];
      if (isUsefulHouseComp(row)) {
        const areaSqm = n(row['建物移轉總面積平方公尺']);
        const total = n(row['總價元']);
        const areaPing = areaSqm ? areaSqm * PING_PER_SQM : null;
        houseBatch.push([season, code, regionId, regionName, row['鄉鎮市區'] || '', row['土地位置建物門牌'] || '', row['交易標的'] || '', row['交易年月日'] || '', yearFromRocDate(row['交易年月日']), areaSqm, areaPing, total, areaPing && total ? (total / 10000) / areaPing : null, row['建物型態'] || '', houseLayout(row), houseParking(row), row['備註'] || '', serial, JSON.stringify({ main: row })]);
      }
      if (!isLikelyLand(row)) { skipped++; continue; }
      const parts = landBySerial.get(serial) || [];
      const landUse = landUseFrom(row, parts);
      if (!isUsefulMarketComp(row, landUse, parts)) { skipped++; continue; }
      const areaSqm = n(row['土地移轉總面積平方公尺']);
      const total = n(row['總價元']);
      const unitSqm = n(row['單價元平方公尺']);
      const areaPing = areaSqm ? areaSqm * PING_PER_SQM : null;
      const unitWanPing = areaPing && total ? (total / 10000) / areaPing : (unitSqm ? unitSqm / 10000 / PING_PER_SQM : null);
      const landPosition = row['土地位置建物門牌'] || '';
      const segment = segmentFromPosition(landPosition) || segmentFromPosition(parts[0]?.['土地位置']);
      batch.push([
        season, code, regionId, regionName, row['鄉鎮市區'] || '', segment, landPosition, row['交易標的'] || '', row['交易年月日'] || '', yearFromRocDate(row['交易年月日']), areaSqm, areaPing, total, unitSqm, unitWanPing,
        row['都市土地使用分區'] || '', row['非都市土地使用分區'] || '', row['非都市土地使用編定'] || '', landUse, [...new Set(parts.map(x => x['移轉情形']).filter(Boolean))].join('；'), row['備註'] || '', serial, JSON.stringify({ main: row, land: parts })
      ]);
    }
    for (let i = 0; i < houseBatch.length; i += 500) {
      const chunk = houseBatch.slice(i, i + 500);
      if (!chunk.length) continue;
      await db.query(`INSERT IGNORE INTO lvr_house_transactions
        (source_season,county_code,region_id,region_name,section_name,address,transaction_target,transaction_date_raw,transaction_year,building_area_sqm,building_area_ping,total_price_ntd,unit_price_wan_ping,building_type,layout_text,parking_text,note,serial_no,raw)
        VALUES ?`, [chunk]);
      houseImported += chunk.length;
    }
    for (let i = 0; i < batch.length; i += 500) {
      const chunk = batch.slice(i, i + 500);
      if (!chunk.length) continue;
      await db.query(`INSERT IGNORE INTO lvr_land_transactions
        (source_season,county_code,region_id,region_name,section_name,segment_name,land_position,transaction_target,transaction_date_raw,transaction_year,area_sqm,area_ping,total_price_ntd,unit_price_sqm,unit_price_wan_ping,urban_zoning,non_urban_zone,non_urban_use,land_use,transfer_status,note,serial_no,raw)
        VALUES ?`, [chunk]);
      imported += chunk.length;
    }
  }
  return { season, imported, houseImported, skipped };
}
export async function importLvrLand(db, { seasons = DEFAULT_SEASONS.slice(0, 12), countyCodes = WEST_CODES } = {}) {
  await ensureSchema(db);
  const results = [];
  for (const season of seasons) results.push(await importSeason(db, season, { countyCodes }));
  const [[total]] = await db.query('SELECT COUNT(*) AS count FROM lvr_land_transactions');
  return { seasons: results, total: total.count };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await pool();
  try {
    const seasonsArg = process.argv.find(x => x.startsWith('--seasons='));
    const countiesArg = process.argv.find(x => x.startsWith('--counties='));
    const seasons = seasonsArg ? seasonsArg.split('=')[1].split(',').filter(Boolean) : DEFAULT_SEASONS.slice(0, 8);
    const countyCodes = countiesArg ? countiesArg.split('=')[1].split(',').filter(Boolean) : WEST_CODES;
    console.log(await importLvrLand(db, { seasons, countyCodes }));
  } finally {
    await db.end();
  }
}
