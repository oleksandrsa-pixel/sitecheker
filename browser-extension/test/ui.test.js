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

    const comp = ctx.buildCompetitorsCsv(
      [{ site: 'A', keyword: 'A', geo: 'Italy', position: 2, domain: 'a.com', collectedAt: new Date().toISOString(), topResults: [{ host: 'a.com', position: 2, title: 'me', url: 'u' }, { host: 'trustpilot.com', position: 1, title: 'tp', url: 'u' }, { host: 'rival.com', position: 3, title: 'r', url: 'u' }] }],
      ['a.com'],
      5,
    );
    ok(comp.includes('rival.com') && !comp.includes('trustpilot.com') && !/(^|,)a\.com(,|$)/m.test(comp.split('\n').slice(1).join('\n')), 'P.12 competitors excludes own + noise, keeps rival');
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
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exitCode = 2;
});
