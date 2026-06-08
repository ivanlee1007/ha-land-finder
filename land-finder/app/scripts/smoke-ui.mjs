import { JSDOM, VirtualConsole } from '/tmp/land591-ui-test/node_modules/jsdom/lib/api.js';

const base = process.env.LAND591_BASE || 'http://127.0.0.1:5910/';
const useRealSettings = process.env.LAND591_SMOKE_USE_REAL_SETTINGS === '1';
const forceLand = !useRealSettings;
const html = await (await fetch(base)).text();
const errors = [];
const requests = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(`jsdom:${e.message}`));
vc.on('error', e => errors.push(`console:${e}`));
const dom = new JSDOM(html, {
  url: base,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.fetch = async (input, init) => {
      const url = new URL(String(input), window.location.href);
      requests.push(url.pathname + url.search);
      if (forceLand && url.pathname === '/api/settings/search' && (!init || String(init.method || 'GET').toUpperCase() === 'GET')) {
        return new Response(JSON.stringify({ value: { criteria: { propertyType: 'house', regionIds: [15], sectionNames: [], maxPriceWan: 1000, minAreaPing: 30, contentExclude: '持分', requireRoad: false }, ui: { sort: 'cp_desc', viewMode: 'card', pageSize: 20, page: 1 } } }), { headers: { 'content-type': 'application/json' } });
      }
      return fetch(url, init);
    };
    window.confirm = () => true;
    window.prompt = (_m, d = '') => d || 'tmp';
    window.print = () => {};
    if (forceLand) {
      const store = new Map();
      window.localStorage.getItem = key => store.get(key) || null;
      window.localStorage.setItem = (key, value) => store.set(key, String(value));
      window.localStorage.removeItem = key => store.delete(key);
    }
  }
});
const d = dom.window.document;
await new Promise(r => setTimeout(r, Number(process.env.LAND591_SMOKE_WAIT_MS || 8000)));
const cards = d.querySelectorAll('.card').length;
const rows = d.querySelectorAll('#tbody tr').length;
const result = {
  cards,
  rows,
  count: d.querySelector('#count')?.textContent || '',
  pageInfo: d.querySelector('#pageInfo')?.textContent || '',
  firstVisible: (d.querySelector('#tbody tr') || d.querySelector('.card'))?.textContent.replace(/\s+/g, ' ').trim().slice(0, 220) || '',
  errors,
  lastRequests: requests.slice(-10)
};
console.log(JSON.stringify(result, null, 2));
if (errors.length || (!cards && !rows)) process.exit(2);
