'use strict';
// Rank Peek beta test #2 — report.js, popup.js, content.js (DOM-dependent).

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const EXT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(cond, name, detail) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
  }
}
const section = (t) => console.log('\n=== ' + t + ' ===');
const flush = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
};

const URLc = URL;
URLc.createObjectURL = () => 'blob:mock';
URLc.revokeObjectURL = () => {};

const BUILTINS = {
  console: Object.assign({}, console, { table: () => {} }),
  URL: URLc,
  URLSearchParams,
  Date,
  Math,
  JSON,
  Promise,
  Set,
  Map,
  RegExp,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Symbol,
  isNaN,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent,
  Blob: function Blob() {},
};

function makeEl() {
  const el = {
    _value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    checked: false,
    style: {},
    files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
    appendChild() {},
    removeChild() {},
    remove() {},
    click() {},
    querySelector() {
      return makeEl();
    },
    querySelectorAll() {
      return [];
    },
  };
  Object.defineProperty(el, 'value', {
    get() {
      return this._value;
    },
    set(v) {
      this._value = v;
    },
  });
  return el;
}

function makeDocument() {
  const cache = {};
  return {
    getElementById(id) {
      return cache[id] || (cache[id] = makeEl());
    },
    createElement() {
      return makeEl();
    },
    querySelector() {
      return makeEl();
    },
    querySelectorAll() {
      return [];
    },
    body: makeEl(),
    documentElement: makeEl(),
  };
}

function makeStorage(seed) {
  const store = Object.assign({}, seed);
  return {
    store,
    local: {
      get(keys, cb) {
        let r = {};
        if (keys == null) r = { ...store };
        else if (typeof keys === 'string') r[keys] = store[keys];
        else if (Array.isArray(keys)) keys.forEach((k) => (r[k] = store[k]));
        else Object.keys(keys).forEach((k) => (r[k] = k in store ? store[k] : keys[k]));
        if (typeof cb === 'function') return void cb(r);
        return Promise.resolve(r);
      },
      set(obj, cb) {
        Object.assign(store, obj);
        if (typeof cb === 'function') return void cb();
        return Promise.resolve();
      },
    },
  };
}

function loadFile(file, extra) {
  const sandbox = Object.assign({}, BUILTINS, extra);
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), ctx, { filename: file });
  return ctx;
}

async function main() {
  // ---------------------------------------------------------------------
  section('R. report.js — pivot, trend, yesterday, CSV');
  {
    const now = new Date().toISOString();
    const storage = makeStorage({
      sweepTargets: [
        { site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' },
        { site: 'A', domain: 'a.com', keyword: 'A casino', gl: 'it', hl: 'it', geo: 'Italy' },
        { site: 'B', domain: 'b.com', keyword: 'B', gl: 'fr', hl: 'fr', geo: 'France' },
      ],
      lastChecks: {
        'a.com|A|it': { site: 'A', domain: 'a.com', geo: 'Italy', gl: 'it', keyword: 'A', position: 2, prevPosition: 3, yesterdayPosition: 5, top1: 'x.com', checkedAt: now },
        'a.com|A casino|it': { site: 'A', domain: 'a.com', geo: 'Italy', gl: 'it', keyword: 'A casino', position: 8, prevPosition: 6, yesterdayPosition: undefined, checkedAt: now },
        'b.com|B|fr': { site: 'B', domain: 'b.com', geo: 'France', gl: 'fr', keyword: 'B', position: null, prevPosition: 4, yesterdayPosition: 3, checkedAt: now },
      },
      history: { 'a.com|A|it': [{ pos: 5, at: now }, { pos: 3, at: now }, { pos: 2, at: now }] },
    });
    const ctx = loadFile('report.js', {
      chrome: { storage: storage.local ? { local: storage.local } : storage },
      document: makeDocument(),
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      location: { href: 'chrome-extension://test/report.html' },
    });
    await flush();

    const rows = ctx.buildRows(storage.store.lastChecks, storage.store.sweepTargets, storage.store.history);
    ok(rows.length === 2, 'R.1 two site rows (a.com, b.com)', String(rows.length));
    const a = rows.find((r) => r.domain === 'a.com');
    ok(a && a.keywords.length === 2, 'R.2 a.com has 2 keyword cells');
    ok(a && a.keywords[0].keyword === 'A' && a.keywords[1].keyword === 'A casino', 'R.3 keyword order follows targets');
    ok(a && a.keywords[0].hist && a.keywords[0].hist.length === 3, 'R.4 history attached to cell');

    // trend
    ok(/tr up/.test(ctx.trendHtml({ position: 2, yesterdayPosition: 5, prevPosition: 3 })) && /▲3/.test(ctx.trendHtml({ position: 2, yesterdayPosition: 5, prevPosition: 3 })), 'R.5 trend up ▲3 vs yesterday');
    ok(/tr down/.test(ctx.trendHtml({ position: 8, yesterdayPosition: undefined, prevPosition: 6 })) && /▼2/.test(ctx.trendHtml({ position: 8, yesterdayPosition: undefined, prevPosition: 6 })), 'R.6 trend down ▼2 vs previous (no yesterday)');
    ok(/▼OUT/.test(ctx.trendHtml({ position: null, yesterdayPosition: 3 })), 'R.7 trend ▼OUT when dropped out');
    ok(/🆕/.test(ctx.trendHtml({ position: 2, yesterdayPosition: undefined, prevPosition: undefined })), 'R.8 🆕 first check');

    // prev line
    ok(ctx.prevLine({ yesterdayPosition: 5 }).includes('вчора: #5'), 'R.9 prevLine yesterday #5');
    ok(ctx.prevLine({ yesterdayPosition: undefined }).includes('вчора: —'), 'R.10 prevLine yesterday —');
    ok(ctx.prevLine({ yesterdayPosition: null }).includes('вчора: OUT'), 'R.11 prevLine yesterday OUT');

    // CSV pivot
    ctx.load();
    await flush();
    const csv = ctx.buildPivotCsv();
    ok(csv.includes('Кейворд 1') && csv.includes('Кейворд 2'), 'R.12 CSV has dynamic keyword columns');
    ok(csv.includes('Вчора 1') && csv.includes('Зміна 1'), 'R.13 CSV has yesterday + change columns');
    ok(csv.includes('▲3'), 'R.14 CSV change ▲3 present');
    ok(csv.includes('▼OUT'), 'R.15 CSV change ▼OUT present');
    ok(csv.charCodeAt(0) === 0xfeff, 'R.16 CSV starts with BOM');
    ok(csv.startsWith('﻿sep=,'), 'R.17 report CSV carries the Excel sep=, hint');

    // Partial coverage: 2 configured keywords, only 1 checked -> BOTH columns
    // still appear (second pending), and site status = 'in' (one keyword #1).
    const partialTargets = [
      { site: 'P', domain: 'p.com', keyword: 'p', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'P', domain: 'p.com', keyword: 'p casino', gl: 'it', hl: 'it', geo: 'Italy' },
    ];
    const partialChecks = {
      'p.com|p|it': { site: 'P', domain: 'p.com', geo: 'Italy', gl: 'it', keyword: 'p', position: 1, error: null, checkedAt: now },
    };
    const prow = ctx.buildRows(partialChecks, partialTargets, {}).find((r) => r.domain === 'p.com');
    ok(prow && prow.keywords.length === 2, 'R.18 both keyword columns present with partial data');
    ok(prow && prow.keywords[1].pending === true, 'R.19 unchecked keyword marked pending');
    ok(prow && ctx.rowStatus(prow) === 'in', 'R.20 site status = in (ranks #1 by one keyword)');

    // Out only when ALL checked and all out
    const outChecks = {
      'p.com|p|it': { site: 'P', domain: 'p.com', geo: 'Italy', gl: 'it', keyword: 'p', position: 8, error: null, checkedAt: now },
      'p.com|p casino|it': { site: 'P', domain: 'p.com', geo: 'Italy', gl: 'it', keyword: 'p casino', position: 9, error: null, checkedAt: now },
    };
    const orow = ctx.buildRows(outChecks, partialTargets, {}).find((r) => r.domain === 'p.com');
    ok(orow && ctx.rowStatus(orow) === 'out', 'R.21 site status = out when ALL keywords out');
    const stillPending = ctx.buildRows({ 'p.com|p|it': outChecks['p.com|p|it'] }, partialTargets, {}).find((r) => r.domain === 'p.com');
    ok(stillPending && ctx.rowStatus(stillPending) === 'pending', 'R.22 status = pending until all keywords checked');
  }

  // ---------------------------------------------------------------------
  section('P. popup.js — CSV import, geo mapping, exports');
  {
    const storage = makeStorage({});
    const ctx = loadFile('popup.js', {
      chrome: {
        storage: { local: storage.local },
        runtime: { sendMessage: () => {}, getURL: (p) => p },
        tabs: { create: () => {} },
      },
      document: makeDocument(),
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
    });
    await flush();

    // geo mapping
    ok(JSON.stringify(ctx.geoToGlHl('Italy')) === JSON.stringify({ gl: 'it', hl: 'it' }), 'P.1 geo Italy -> it/it');
    ok(JSON.stringify(ctx.geoToGlHl('Brazil')) === JSON.stringify({ gl: 'br', hl: 'pt-BR' }), 'P.2 geo Brazil -> br/pt-BR');
    ok(JSON.stringify(ctx.geoToGlHl('Narnia', 'de')) === JSON.stringify({ gl: 'de', hl: 'de' }), 'P.3 unknown geo falls back to lang column');
    ok(JSON.stringify(ctx.geoToGlHl('Narnia', '')) === JSON.stringify({ gl: 'us', hl: 'en' }), 'P.4 unknown geo + no lang -> us/en');

    // hostFromUrl
    ok(ctx.hostFromUrl('https://www.Foo.com/path?x=1') === 'foo.com', 'P.5 hostFromUrl strips scheme/www/path');
    ok(ctx.hostFromUrl('bar.com') === 'bar.com', 'P.6 hostFromUrl bare domain');

    // CSV import
    const csv = [
      'GEO,Brand,Domain,keyword,second keyword,is_active',
      'Italy,Betscore,https://betscore-1casino.com,Betscore,Betscore casino,TRUE',
      'France,Nvcasino,nvcasino-frances.com,Nvcasino,,true',
      'Spain,Dead,dead.com,Dead,,FALSE',
    ].join('\n');
    const targets = ctx.parseCsvToTargets(csv);
    ok(targets.length === 3, 'P.7 import: 2 active rows -> 3 targets (Betscore has 2 keywords)', String(targets.length));
    ok(targets.some((t) => t.domain === 'betscore-1casino.com' && t.keyword === 'Betscore casino' && t.gl === 'it'), 'P.8 second keyword expanded + hostname parsed');
    ok(!targets.some((t) => t.site === 'Dead'), 'P.9 is_active=FALSE row skipped');

    // exports
    const rows = [
      { site: 'A', keyword: 'A', geo: 'Italy', position: 2, domain: 'a.com', collectedAt: new Date().toISOString(), topResults: [{ host: 'x.com' }] },
      { site: 'B', keyword: 'B', geo: 'France', position: null, domain: 'b.com', collectedAt: new Date().toISOString(), topResults: [] }, // OUT (no error)
      { site: 'C', keyword: 'C', geo: 'Spain', position: null, domain: 'c.com', error: 'timeout', collectedAt: new Date().toISOString(), topResults: [] }, // ERR
    ];
    const outCsv = ctx.buildCsv(rows);
    ok(outCsv.includes('Сайт') && outCsv.charCodeAt(0) === 0xfeff, 'P.10 buildCsv header + BOM');
    ok(/(^|,)OUT(,|$)/m.test(outCsv) && outCsv.includes('ERR'), 'P.11 buildCsv OUT + ERR markers');

    // Minimal 4-column format (no Brand) + dedupe
    const minCsv = [
      'Domain,keyword,second keyword,GEO',
      'https://zoccer-online-casino.com/es-es/,zoccer,zoccer casino,Spain',
      'https://zoccer-online-casino.com/es-es/,zoccer,zoccer casino,Spain', // exact dup
      'magneticslotcasino.com,magneticslots,,Portugal',
    ].join('\n');
    const minT = ctx.parseCsvToTargets(minCsv);
    ok(minT.length === 3, 'P.13 minimal format: 2 zoccer targets + 1 magneticslots (dup collapsed)', String(minT.length));
    ok(minT.duplicatesRemoved === 2, 'P.14 duplicatesRemoved counts the repeated row (2 kw)', String(minT.duplicatesRemoved));
    ok(minT.every((t) => t.site && t.gl && t.hl), 'P.15 site auto-derived + gl/hl set without Brand');
    ok(minT.find((t) => t.domain === 'zoccer-online-casino.com').site === 'Zoccer', 'P.16 site derived from keyword (Zoccer)');
    ok(minT.find((t) => t.domain === 'magneticslotcasino.com').gl === 'pt', 'P.17 GEO Portugal -> gl pt');

    // 2-letter geo code accepted
    ok(JSON.stringify(ctx.geoToGlHl('es')) === JSON.stringify({ gl: 'es', hl: 'es' }), 'P.18 bare country code es -> es/es');

    // header aliases (url + country)
    const aliasCsv = ['url,keyword,country', 'foo.it,foo,Italy'].join('\n');
    const aliasT = ctx.parseCsvToTargets(aliasCsv);
    ok(aliasT.length === 1 && aliasT[0].domain === 'foo.it' && aliasT[0].gl === 'it', 'P.19 header aliases url/country work');

    // missing required column -> clear error
    let threw = '';
    try { ctx.parseCsvToTargets('keyword,GEO\nfoo,Italy'); } catch (e) { threw = e.message; }
    ok(/Domain/.test(threw), 'P.20 missing Domain throws clear error');

    // Excel friendliness: exports carry a sep=, hint so Excel splits columns
    ok(outCsv.startsWith('﻿sep=,'), 'P.21 buildCsv starts with BOM + sep=, hint');

    // Import tolerates the sep= line and semicolon delimiter (re-saved from Excel)
    const sepCsv = ['sep=,', 'Domain,keyword,GEO', 'foo.it,foo,Italy'].join('\r\n');
    const sepT = ctx.parseCsvToTargets(sepCsv);
    ok(sepT.length === 1 && sepT[0].domain === 'foo.it', 'P.23 import skips a leading sep= line');

    const semiCsv = ['Domain;keyword;GEO', 'foo.it;foo;Italy'].join('\n');
    const semiT = ctx.parseCsvToTargets(semiCsv);
    ok(semiT.length === 1 && semiT[0].gl === 'it', 'P.24 import auto-detects semicolon delimiter');

    const sepSemi = ['sep=;', 'Domain;keyword;GEO', 'foo.it;foo;Italy'].join('\r\n');
    const sepSemiT = ctx.parseCsvToTargets(sepSemi);
    ok(sepSemiT.length === 1 && sepSemiT[0].domain === 'foo.it', 'P.25 import honours sep=; hint');

    // Telegram error hints — actionable guidance for the most common failures
    ok(/start/i.test(ctx.tgHint('Bad Request: chat not found')), 'P.26 "chat not found" -> hint to press Start / fix chat_id');
    ok(/token/i.test(ctx.tgHint('Unauthorized')), 'P.27 "Unauthorized" -> hint to re-copy the Bot token');
    ok(/start/i.test(ctx.tgHint("Forbidden: bot can't initiate conversation with a user")), 'P.28 "can\'t initiate" -> hint to press Start');
  }

  // ---------------------------------------------------------------------
  section('C. content.js — SERP parse + block detection');
  {
    // Build a fake SERP DOM
    function h3(host, title, block) {
      const anchor = { href: `https://${host}/path` };
      return {
        textContent: title || host,
        closest(sel) {
          if (sel === 'a[href]') return anchor;
          if (sel === '[data-hveid]') return block;
          if (sel === '.g') return block;
          return anchor;
        },
      };
    }
    const b = (n) => ({ id: 'block' + n });
    const nodes = [
      h3('foo.com', 'Foo', b(1)),
      h3('play.google.com', 'Play', b(2)),
      h3('google.com', 'Google self', b(3)), // must be skipped
      h3('foo.com', 'Foo dup', b(4)), // dup host -> skipped
      h3('bar.com', 'Bar', b(5)),
    ];
    const scope = { querySelectorAll: (sel) => (sel === 'h3' ? nodes : []) };
    const document = {
      querySelector(sel) {
        if (sel === '#rso') return scope;
        return null; // no captcha elements
      },
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => makeEl(),
      documentElement: makeEl(),
      body: { innerText: '' },
    };
    const sent = [];
    let intervalFn = null;
    const ctx = loadFile('content.js', {
      chrome: {
        storage: { local: makeStorage({ targets: ['foo.com'] }).local },
        runtime: { sendMessage: (m) => sent.push(m) },
      },
      document,
      location: { href: 'https://www.google.com/search?q=Foo&gl=it', pathname: '/search' },
      setInterval: (fn) => {
        intervalFn = fn;
        return 1;
      },
      clearInterval: () => {},
      setTimeout: () => 0,
    });
    await intervalFn();
    await flush();
    const serpMsg = sent.find((m) => m.type === 'rankpeek:serp');
    ok(!!serpMsg, 'C.1 serp message sent');
    const res = serpMsg ? serpMsg.payload.results : [];
    ok(res.length === 3, 'C.2 parsed 3 organic (google.com + dup skipped)', String(res.length));
    ok(res[0].host === 'foo.com' && res[0].position === 1, 'C.3 pos1 foo.com');
    ok(res[1].host === 'play.google.com' && res[1].position === 2, 'C.4 play.google.com kept as pos2');
    ok(res[2].host === 'bar.com' && res[2].position === 3, 'C.5 bar.com pos3');

    // Blocked scenario
    const sent2 = [];
    let ifn2 = null;
    const doc2 = {
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => makeEl(),
      documentElement: makeEl(),
      body: { innerText: 'Our systems have detected unusual traffic from your computer network.' },
    };
    loadFile('content.js', {
      chrome: { storage: { local: makeStorage({}).local }, runtime: { sendMessage: (m) => sent2.push(m) } },
      document: doc2,
      location: { href: 'https://www.google.com/search?q=Foo', pathname: '/search' },
      setInterval: (fn) => {
        ifn2 = fn;
        return 1;
      },
      clearInterval: () => {},
      setTimeout: () => 0,
    });
    await ifn2();
    await flush();
    ok(sent2.some((m) => m.type === 'rankpeek:blocked'), 'C.6 block message sent on "unusual traffic"');
    ok(!sent2.some((m) => m.type === 'rankpeek:serp'), 'C.7 no serp message when blocked');

    // Hard IP 403 page (served on /search itself, no /sorry redirect)
    const sent3 = [];
    let ifn3 = null;
    const doc3 = {
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => makeEl(),
      documentElement: makeEl(),
      body: { innerText: "403. That's an error. Your client does not have permission to get URL /search?q=... from this server. That's all we know." },
    };
    loadFile('content.js', {
      chrome: { storage: { local: makeStorage({}).local }, runtime: { sendMessage: (m) => sent3.push(m) } },
      document: doc3,
      location: { href: 'https://www.google.com/search?q=x', pathname: '/search' },
      setInterval: (fn) => { ifn3 = fn; return 1; },
      clearInterval: () => {},
      setTimeout: () => 0,
    });
    await ifn3();
    await flush();
    ok(sent3.some((m) => m.type === 'rankpeek:blocked'), 'C.8 block detected on hard 403 "does not have permission" page');
  }

  // ---------------------------------------------------------------------
  section('K. drops.js — ᐉ-stencil drop detection, active-brand watchlist, copyable URLs');
  {
    const now = new Date().toISOString();
    const storage = makeStorage({
      dropWatch: ['zoccer-online-casino.com'], // only this brand is "active"
      lastChecks: {
        'zoccer-online-casino.com|zoccer|es': {
          site: 'Zoccer', keyword: 'zoccer', geo: 'Spain', gl: 'es', domain: 'zoccer-online-casino.com',
          position: 2, error: null, checkedAt: now,
          serpTop: [
            { position: 1, host: 'beachxbums.com', url: 'https://beachxbums.com/x', title: 'Zoccer Official Site ᐉ Zoccer Login', own: false }, // DROP (stencil)
            { position: 2, host: 'zoccer-online-casino.com', url: 'https://zoccer-online-casino.com/es-es/', title: 'Zoccer', own: true }, // you
            { position: 3, host: 'trustpilot.com', url: 'https://trustpilot.com/review/zoccer', title: 'Reviews', own: false }, // noise
            { position: 4, host: 'megaslots-casino.com', url: 'https://megaslots-casino.com/', title: 'MegaSlots', own: false }, // comp
            { position: 5, host: 'hanami-sushi.it', url: 'https://hanami-sushi.it/', title: 'Zoccer Sitio Oficial ᐉ Zoccer Acceso', own: false }, // DROP (stencil, localized)
            { position: 6, host: 'someblog-review.com', url: 'https://someblog-review.com/', title: 'Top 10 Casinos 2024 ᐉ Best Bonuses', own: false }, // has ᐉ but NOT a stencil -> other
          ],
        },
        'b.com|b|fr': { site: 'B', keyword: 'b', geo: 'France', gl: 'fr', domain: 'b.com', position: null, error: null, checkedAt: now, serpTop: [] },
      },
    });
    const ctx = loadFile('drops.js', {
      chrome: { storage: { local: storage.local } },
      document: makeDocument(),
      navigator: {},
      setInterval: () => 0,
      clearInterval: () => 0,
      setTimeout: () => 0,
      location: { href: 'chrome-extension://test/drops.html' },
    });
    await flush();

    const check = storage.store.lastChecks['zoccer-online-casino.com|zoccer|es'];
    const serp = ctx.buildSerp(check);
    ok(serp.find((x) => x.host === 'zoccer-online-casino.com').kind === 'you', 'K.1 own target classified as YOU');
    ok(serp.find((x) => x.host === 'beachxbums.com').kind === 'drop', 'K.2 ᐉ stencil title -> DROP');
    ok(serp.find((x) => x.host === 'hanami-sushi.it').kind === 'drop', 'K.3 localized ᐉ stencil title -> DROP');
    ok(serp.find((x) => x.host === 'someblog-review.com').kind === 'other', 'K.4 has ᐉ but NOT a stencil -> other (the false-positive we fixed)');
    ok(serp.find((x) => x.host === 'trustpilot.com').kind === 'noise', 'K.5 aggregator classified as noise');
    ok(serp.find((x) => x.host === 'megaslots-casino.com').kind === 'comp', 'K.6 gambling domain -> competitor');

    // stencil detector: ᐉ + a structural signal (brand repeated / official+login)
    ok(ctx.isDropTitle('Casea Official Site ᐉ Casea Login', 'casea') && ctx.isDropTitle('Vipsta Official Site ᐉ Vipsta Login', 'vipsta'), 'K.7 isDropTitle: real stencils -> true');
    ok(!ctx.isDropTitle('Top 10 Casinos 2024 ᐉ Best Bonuses', 'casea') && !ctx.isDropTitle('Casea Casino Review ᐉ Bonus Codes', 'casea') && !ctx.isDropTitle('No marker here at all', 'casea'), 'K.7b isDropTitle: ᐉ-only / review / no-marker -> false');
    // brand-anchored: brandless / one-sided-brand / decorative-ᐉ / substring-brand all excluded
    ok(!ctx.isDropTitle('Best Casinos ᐉ How to Login to the Official App', 'casea') && !ctx.isDropTitle('Casea Casino ᐉ Official Site & Player Login Guide', 'casea') && !ctx.isDropTitle('Casino Bonus 2024 ᐉ Casino Reviews', 'casea') && !ctx.isDropTitle('Bethesda official ᐉ better login page', 'bet'), 'K.7c isDropTitle: brandless / review / listicle / substring-brand -> false');
    ok(ctx.isDropTitle('Sitio Oficial de Casea ᐉ Casea - Acceso', 'casea') && ctx.isDropTitle('Il sito ufficiale Casea ᐉ Accedi a Casea', 'casea'), 'K.7d isDropTitle: both-sides / brand-not-first variants -> true');

    // the active-brand watchlist scopes the view to only watched brands
    const shown = ctx.view();
    ok(shown.length === 1 && shown[0].domain === 'zoccer-online-casino.com', 'K.8 view() shows only the active (watched) brand, hides b.com');
    ok(shown[0].drops === 2, 'K.9 watched brand reports exactly the 2 ᐉ-marked drops (review/competitor/aggregator excluded)');

    // watchlist parsing — full CSV format (Domain, keyword, second keyword, GEO)
    const parsed = ctx.parseWatchTargets('Domain,keyword,second keyword,GEO\nhttps://betscore-1casino.com/it8-it8/,betscore,betscore casino,Italy\nspinpolocasino.it,spinpolo,,Italy');
    ok(parsed.length === 3, 'K.10 parseWatchTargets expands second keyword (betscore ×2 + spinpolo ×1 = 3 targets)', String(parsed.length));
    ok(parsed.some((t) => t.domain === 'betscore-1casino.com' && t.keyword === 'betscore casino' && t.gl === 'it'), 'K.10b full targets carry keyword + geo->gl');
    const bareT = ctx.parseWatchTargets('winnercasino-it.com\ntwincasinos-pt.com');
    ok(bareT.length === 2 && bareT[0].domain === 'winnercasino-it.com' && !bareT[0].keyword, 'K.10c bare-domain list -> domain-only entries (filter fallback)');

    const csv = ctx.buildCsv();
    ok(csv.startsWith('﻿sep=,'), 'K.11 CSV starts with BOM + sep=, hint');
    ok(csv.includes('Тип') && csv.includes('Дроп?') && csv.includes('URL'), 'K.12 CSV has Тип + Дроп? + URL columns');
    ok(csv.includes('ВАШ САЙТ') && csv.includes('ДРОП') && csv.includes('конкурент') && csv.includes('агрегатор'), 'K.13 CSV labels every row type');
    ok(/(^|,)так(,|$)/m.test(csv), 'K.14 drop rows flagged "так" in the Дроп? column');
    ok(csv.includes('https://zoccer-online-casino.com/es-es/'), 'K.15 full copyable URL present in export');
    ok(!csv.includes('b.com'), 'K.16 CSV export scoped to the watchlist (b.com excluded)');
  }

  // ---------------------------------------------------------------------
  section('RY. report yesterday mode (positions ~24h ago)');
  {
    const nowMs = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const storage = makeStorage({
      sweepTargets: [{ site: 'A', domain: 'a.com', keyword: 'a', gl: 'it', hl: 'it', geo: 'Italy' }],
      lastChecks: { 'a.com|a|it': { site: 'A', domain: 'a.com', geo: 'Italy', gl: 'it', keyword: 'a', position: 8, error: null, checkedAt: iso(nowMs) } },
      history: { 'a.com|a|it': [{ pos: 3, at: iso(nowMs - 25 * 3600 * 1000) }, { pos: 8, at: iso(nowMs) }] },
    });
    const ctx = loadFile('report.js', {
      chrome: { storage: { local: storage.local } },
      document: makeDocument(),
      setInterval: () => 0,
      clearInterval: () => 0,
      setTimeout: () => 0,
      location: { href: 'chrome-extension://test/report.html', search: '' },
    });
    await flush();
    const rows = ctx.buildRows(storage.store.lastChecks, storage.store.sweepTargets, storage.store.history);
    const cell = rows[0].keywords[0];
    ok(cell.position === 8, 'RY.1 today position = 8');
    ok(cell.yPos === 3, 'RY.2 yesterday position (from history ~24h ago) = 3');
    ok(ctx.rowStatus(rows[0]) === 'out', 'RY.3 today: site OUT (8 > 5)');
    ctx.setDay('yesterday');
    ok(ctx.dispPos(cell) === 3, 'RY.4 yesterday mode dispPos = 3');
    ok(ctx.rowStatus(rows[0]) === 'in', 'RY.5 yesterday: site IN (3 <= 5)');
    ctx.setDay('today');
    ok(ctx.rowStatus(rows[0]) === 'out', 'RY.6 back to today: OUT again');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exitCode = 2;
});
