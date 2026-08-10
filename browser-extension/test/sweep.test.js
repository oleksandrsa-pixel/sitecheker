'use strict';
// Rank Peek beta test — loads the real extension files in a mocked
// chrome/DOM/fetch environment and drives real scenarios.

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const EXT = require('path').join(__dirname, '..');

let passed = 0;
let failed = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    fails.push(name + (detail ? ` — ${detail}` : ''));
    console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
  }
}
function section(t) {
  console.log('\n=== ' + t + ' ===');
}

const flush = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
};

const BUILTINS = {
  console,
  URL,
  URLSearchParams,
  Date,
  Math,
  JSON,
  Promise,
  Set,
  Map,
  WeakSet,
  WeakMap,
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
  TextEncoder,
  TextDecoder,
};

// ---- chrome + fetch mock ---------------------------------------------------

function makeEnv() {
  const store = {};
  const alarms = {};
  const listeners = { message: [], alarm: [], tabUpdated: [], startup: [], installed: [] };
  const tabs = {};
  let tabSeq = 100;
  const calls = {
    tabsCreated: [],
    tabsRemoved: [],
    tabsUpdated: [],
    windowsUpdated: [],
    notifications: [],
    ingest: [],
    tg: [], // telegram message texts
    sheets: [], // Google Sheets API urls hit
  };

  const local = {
    get(keys, cb) {
      let result = {};
      if (keys == null) result = { ...store };
      else if (typeof keys === 'string') result[keys] = store[keys];
      else if (Array.isArray(keys)) keys.forEach((k) => (result[k] = store[k]));
      else if (typeof keys === 'object')
        Object.keys(keys).forEach((k) => (result[k] = k in store ? store[k] : keys[k]));
      if (typeof cb === 'function') return void cb(result);
      return Promise.resolve(result);
    },
    set(obj, cb) {
      Object.assign(store, obj);
      if (typeof cb === 'function') return void cb();
      return Promise.resolve();
    },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]);
      if (typeof cb === 'function') return void cb();
      return Promise.resolve();
    },
  };

  const chrome = {
    storage: { local },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      sendMessage: (msg, cb) => {
        // content -> background bridge is simulated explicitly in tests; here we
        // just record and optionally ack.
        if (typeof cb === 'function') cb({ ok: true });
      },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    tabs: {
      create: async ({ url, active }) => {
        const id = (tabSeq += 1);
        tabs[id] = { id, url, windowId: 1, active };
        calls.tabsCreated.push({ id, url, active });
        return { id, windowId: 1 };
      },
      remove: async (id) => {
        calls.tabsRemoved.push(id);
        delete tabs[id];
      },
      update: async (id, info) => {
        calls.tabsUpdated.push({ id, info });
        if (tabs[id]) Object.assign(tabs[id], info);
        return tabs[id] || { id };
      },
      get: async (id) => {
        if (!tabs[id]) throw new Error('no such tab');
        return tabs[id];
      },
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
    },
    alarms: {
      create: async (name, info) => {
        alarms[name] = info || {};
      },
      clear: async (name) => {
        delete alarms[name];
        return true;
      },
      clearAll: async () => {
        Object.keys(alarms).forEach((k) => delete alarms[k]);
        return true;
      },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    notifications: {
      create: async (opts) => {
        calls.notifications.push(opts);
      },
    },
    windows: {
      update: async (id, info) => {
        calls.windowsUpdated.push({ id, info });
      },
    },
  };

  async function fetchMock(url, opts) {
    if (/sheets\.googleapis\.com/.test(url)) {
      calls.sheets.push(url);
      const sd = store.__sheet || { titles: [], grids: {} };
      if (/\/values:batchGet/.test(url)) {
        return { ok: true, json: async () => ({ valueRanges: sd.titles.map((t) => ({ values: sd.grids[t] || [] })) }) };
      }
      return { ok: true, json: async () => ({ sheets: sd.titles.map((t) => ({ properties: { title: t } })) }) };
    }
    if (/api\.telegram\.org/.test(url)) {
      let body = {};
      try {
        body = JSON.parse(opts.body);
      } catch {}
      calls.tg.push(body.text || '');
      // Simulate a Telegram API failure for a sentinel chat_id (the classic
      // "user never pressed Start / wrong id" case).
      if (body.chat_id === 'BADCHAT') {
        return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
    calls.ingest.push({ url, body: opts && opts.body });
    return { ok: true, json: async () => ({}) };
  }

  return { chrome, fetchMock, store, alarms, listeners, tabs, calls };
}

function loadBackground(env) {
  const sandbox = Object.assign({}, BUILTINS, {
    chrome: env.chrome,
    fetch: env.fetchMock,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
  });
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), context, {
    filename: 'background.js',
  });
  return context;
}

// ---- background driver -----------------------------------------------------

function makeDriver(env) {
  const fire = {
    async message(msg, sender) {
      env.listeners.message.forEach((fn) => fn(msg, sender || {}, () => {}));
      await flush();
    },
    async alarm(name) {
      env.listeners.alarm.forEach((fn) => fn({ name }));
      await flush();
    },
    async tabUpdated(tabId, changeInfo, tab) {
      env.listeners.tabUpdated.forEach((fn) => fn(tabId, changeInfo, tab));
      await flush();
    },
  };
  return fire;
}

// Run a full sweep. serpFor(target, index) -> array of SERP results | 'timeout'.
async function runSweep(env, fire, serpFor) {
  await fire.message({ type: 'rankpeek:start' });
  let guard = 0;
  while (env.store.sweep && env.store.sweep.running && guard < 2000) {
    guard += 1;
    const s = env.store.sweep;
    if (s.paused) break;
    if (!s.current) {
      if (env.alarms.next) {
        await fire.alarm('next');
        continue;
      }
      break;
    }
    const t = s.current.target;
    const tabId = s.current.tabId;
    const outcome = serpFor(t, s.index);
    if (outcome === 'timeout') {
      await fire.alarm('timeout');
    } else {
      await fire.message(
        { type: 'rankpeek:serp', payload: { q: t.keyword, gl: t.gl, results: outcome } },
        { tab: { id: tabId } },
      );
      if (env.alarms.next) await fire.alarm('next');
    }
  }
  return guard;
}

const serp = (arr) => arr.map((x, i) => ({ host: x.host, position: i + 1, url: `https://${x.host}/`, title: x.host }));
// Build a SERP where a given target domain sits at position `pos` (1-based), OUT if null.
function serpWithTarget(domain, pos) {
  const fillers = ['a-competitor.com', 'b-competitor.com', 'c-competitor.com', 'd-competitor.com', 'e-competitor.com', 'f-competitor.com', 'g-competitor.com', 'h-competitor.com', 'i-competitor.com', 'j-competitor.com'];
  const hosts = [];
  for (let i = 1; i <= 10; i += 1) {
    if (pos && i === pos) hosts.push(domain);
    else hosts.push(fillers[i - 1]);
  }
  return serp(hosts.map((h) => ({ host: h })));
}

// ===========================================================================

async function main() {
  // ---------------------------------------------------------------------
  section('1. Full sweep — happy path (10 default targets)');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [
      { site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'A', domain: 'a.com', keyword: 'A casino', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'B', domain: 'b.com', keyword: 'B', gl: 'fr', hl: 'fr', geo: 'France' },
    ];
    const positions = { A: 2, 'A casino': 7, B: null };
    await runSweep(env, fire, (t) => serpWithTarget(t.domain, positions[t.keyword]));

    const s = env.store.sweep;
    ok(s && s.running === false, '1.1 sweep finished (running=false)');
    ok(s && s.results.length === 3, '1.2 recorded 3 results', s && String(s.results.length));
    ok(env.calls.ingest.length === 3, '1.3 posted 3 results to ingest', String(env.calls.ingest.length));
    const lc = env.store.lastChecks || {};
    ok(lc['a.com|A|it'] && lc['a.com|A|it'].position === 2, '1.4 lastChecks position for A/A/it = 2');
    ok(lc['b.com|B|fr'] && lc['b.com|B|fr'].position === null, '1.5 B OUT recorded as null');
    ok((env.store.history['a.com|A|it'] || []).length === 1, '1.6 history seeded for A');
    ok(env.calls.tabsRemoved.length === 3, '1.7 all sweep tabs closed', String(env.calls.tabsRemoved.length));
    ok(!env.alarms.timeout, '1.8 no dangling timeout alarm');
  }

  // ---------------------------------------------------------------------
  section('2. Per-SITE alerts: in-top by ANY keyword = silent; out by ALL = alert');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    // ONE site, TWO keywords, one geo.
    env.store.sweepTargets = [
      { site: 'Brandy', domain: 's.com', keyword: 'brand', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'Brandy', domain: 's.com', keyword: 'brand casino', gl: 'it', hl: 'it', geo: 'Italy' },
    ];
    env.store.telegramToken = 'TOK';
    env.store.telegramChatId = 'CHAT';
    env.store.alertMaxPos = 5;

    // run1: in top by ONE keyword (brand #2), the other out (#8) -> site OK, silent
    await runSweep(env, fire, (t) => serpWithTarget('s.com', t.keyword === 'brand' ? 2 : 8));
    let tg = env.calls.tg.slice();
    ok(!tg.some((m) => m.includes('Випав із топ')), '2.1 run1: NO drop alert (in top by 1 keyword)');
    ok(tg.some((m) => m.includes('Проблемних нема')), '2.2 run1 digest: all-clear (site counts as in top)');

    // run2: out by ALL keywords (both #8) -> transition in->out -> one drop alert
    env.calls.tg.length = 0;
    await runSweep(env, fire, () => serpWithTarget('s.com', 8));
    tg = env.calls.tg.slice();
    ok(tg.filter((m) => m.includes('Випав із топ')).length === 1, '2.3 run2: exactly one drop alert when out by ALL keywords', String(tg.filter((m) => m.includes('Випав із топ')).length));
    ok(tg.some((m) => m.includes('поза топ-5')), '2.4 run2 digest lists the site as out');
    ok(env.store.siteStatus['s.com|it'] === 'out', '2.5 site status persisted as out');

    // run3: back in top by one keyword -> recovery alert
    env.calls.tg.length = 0;
    await runSweep(env, fire, (t) => serpWithTarget('s.com', t.keyword === 'brand' ? 2 : 8));
    tg = env.calls.tg.slice();
    ok(tg.filter((m) => m.includes('Знову в топ')).length === 1, '2.6 run3: one recovery alert when back in top by a keyword');
    ok(tg.some((m) => m.includes('Проблемних нема')), '2.7 run3 digest: all-clear again');
  }

  // ---------------------------------------------------------------------
  section('3. Telegram digest: all-clear + only-errors');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [{ site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' }];
    env.store.telegramToken = 'TOK';
    env.store.telegramChatId = 'CHAT';
    await runSweep(env, fire, (t) => serpWithTarget(t.domain, 3));
    ok(env.calls.tg.some((m) => m.includes('Проблемних нема')), '3.1 all-clear digest when everything in top');

    const env2 = makeEnv();
    loadBackground(env2);
    const fire2 = makeDriver(env2);
    env2.store.sweepTargets = [{ site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' }];
    env2.store.telegramToken = 'TOK';
    env2.store.telegramChatId = 'CHAT';
    await runSweep(env2, fire2, () => 'timeout');
    ok(env2.calls.tg.some((m) => m.includes('результатів нема')), '3.2 only-errors digest');
  }

  // ---------------------------------------------------------------------
  section('4. History / yesterday / trend fields');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    const key = 'a.com|A|it';
    const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
    env.store.sweepTargets = [{ site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' }];
    env.store.history = { [key]: [{ pos: 2, at: ago(25) }, { pos: 3, at: ago(5) }] };
    await runSweep(env, fire, (t) => serpWithTarget(t.domain, 6));
    const lc = env.store.lastChecks[key];
    ok(lc.position === 6, '4.1 current position 6');
    ok(lc.prevPosition === 3, '4.2 prevPosition = last history entry (3)', String(lc.prevPosition));
    ok(lc.yesterdayPosition === 2, '4.3 yesterdayPosition = entry >=24h old (2)', String(lc.yesterdayPosition));
    ok((env.store.history[key] || []).length === 3, '4.4 history appended (now 3)');
  }

  // ---------------------------------------------------------------------
  section('5. Block via content message -> pause -> manual solve -> resume');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [
      { site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'B', domain: 'b.com', keyword: 'B', gl: 'fr', hl: 'fr', geo: 'France' },
    ];
    env.store.telegramToken = 'TOK';
    env.store.telegramChatId = 'CHAT';
    await fire.message({ type: 'rankpeek:start' }); // opens target A
    const tabId = env.store.sweep.current.tabId;
    await fire.message({ type: 'rankpeek:blocked' }, { tab: { id: tabId } });

    let s = env.store.sweep;
    ok(s.paused === true && s.blocked === true, '5.1 sweep paused+blocked on CAPTCHA');
    ok(!!env.alarms.resume, '5.2 resume (cooldown) alarm armed');
    ok(!env.alarms.timeout && !env.alarms.next, '5.3 timeout/next alarms cleared while blocked');
    ok(env.calls.tabsUpdated.some((u) => u.info.active === true && u.id === tabId), '5.4 challenge tab brought to front');
    ok(env.calls.notifications.length >= 1, '5.5 system notification shown');
    ok(env.calls.tg.some((m) => m.includes('на паузі')), '5.6 telegram pause notice sent');
    ok(s.index === 0, '5.7 index NOT advanced (target retained)');

    // user solves -> content script re-reports SERP on same tab (targets are
    // shuffled, so use whatever the current blocked target is)
    const bt = env.store.sweep.current.target;
    const btKey = `${bt.domain}|${bt.keyword}|${bt.gl}`;
    await fire.message(
      { type: 'rankpeek:serp', payload: { q: bt.keyword, gl: bt.gl, results: serpWithTarget(bt.domain, 2) } },
      { tab: { id: tabId } },
    );
    s = env.store.sweep;
    ok(s.paused === false && s.blocked === false, '5.8 unblocked after solving');
    ok(!env.alarms.resume, '5.9 resume alarm cleared after solve');
    ok(env.store.lastChecks[btKey] && env.store.lastChecks[btKey].position === 2, '5.10 blocked target got recorded (#2)');
    // finish the sweep
    if (env.alarms.next) await fire.alarm('next');
    await runSweep2Continue(env, fire);
    ok(env.store.sweep.running === false, '5.11 sweep completes after resume');
  }

  // ---------------------------------------------------------------------
  section('6. Block via tab redirect to /sorry/ (onUpdated)');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [{ site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' }];
    await fire.message({ type: 'rankpeek:start' });
    const tabId = env.store.sweep.current.tabId;
    await fire.tabUpdated(tabId, { url: 'https://www.google.com/sorry/index?continue=...' }, { id: tabId, url: 'https://www.google.com/sorry/index' });
    ok(env.store.sweep.paused === true, '6.1 paused on /sorry/ redirect');
    ok(env.store.sweep.blockedReason === 'captcha', '6.2 reason=captcha');
  }

  // ---------------------------------------------------------------------
  section('7. Soft block: two consecutive timeouts -> cooldown telegram');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [
      { site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'B', domain: 'b.com', keyword: 'B', gl: 'fr', hl: 'fr', geo: 'France' },
    ];
    env.store.telegramToken = 'TOK';
    env.store.telegramChatId = 'CHAT';
    await runSweep(env, fire, () => 'timeout');
    ok(env.calls.tg.some((m) => m.includes('схоже на блокування')), '7.1 soft-block cooldown telegram after 2 errors');
    ok(env.store.sweep.running === false, '7.2 sweep still completes');
  }

  // ---------------------------------------------------------------------
  section('8. Stop cancels alarms');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [{ site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' }];
    await fire.message({ type: 'rankpeek:start' });
    await fire.message({ type: 'rankpeek:stop' });
    ok(env.store.sweep.running === false, '8.1 stopped');
    ok(!env.alarms.next && !env.alarms.timeout && !env.alarms.resume, '8.2 all alarms cleared');
  }

  // ---------------------------------------------------------------------
  section('9. Malformed target is skipped, not crashing');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    // bypass validTargets by putting a valid + invalid via direct sweep state is hard;
    // instead craft sweepTargets where one row misses hl (validTargets rejects whole list
    // -> falls back to defaults). So test the in-step guard via a hand-built sweep.
    env.store.sweep = {
      running: true, paused: false, blocked: false, index: 0, sinceBreak: 0, consecutiveErrors: 0,
      targets: [{ site: 'X', domain: 'x.com', keyword: '', gl: '', hl: '' }],
      ingestUrl: 'http://127.0.0.1:33000/ingest/serp', stepDelayMs: 20000, batchSize: 20,
      batchPauseMs: 180000, cooldownMs: 1800000, alertMaxPos: 5, telegramToken: '', telegramChatId: '',
      results: [], current: null, startedAt: Date.now(),
    };
    await fire.alarm('next'); // triggers step() on the malformed target
    // advance through the scheduled 'next'
    let g = 0;
    while (env.store.sweep.running && env.alarms.next && g < 10) { await fire.alarm('next'); g += 1; }
    const r = env.store.sweep.results[0];
    ok(r && /invalid target/.test(r.error), '9.1 malformed target recorded as invalid, sweep survived');
  }

  // ---------------------------------------------------------------------
  section('10. drip mode: fixed-gap pacing + continuous restart + shuffle');
  {
    const env = makeEnv();
    const ctx = loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [
      { site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'B', domain: 'b.com', keyword: 'B', gl: 'fr', hl: 'fr', geo: 'France' },
    ];
    env.store.dripMode = true;
    env.store.dripGapMin = 4;
    env.store.quietEnabled = false; // don't let real clock interfere with this test

    // pure helpers
    ok(ctx.inQuietHours(new Date(2026, 0, 1, 2, 0), 23, 7) === true, '10.a inQuietHours wrap: 02:00 is quiet (23->7)');
    ok(ctx.inQuietHours(new Date(2026, 0, 1, 12, 0), 23, 7) === false, '10.b inQuietHours: 12:00 not quiet');
    ok(ctx.inQuietHours(new Date(2026, 0, 1, 10, 0), 1, 6) === false, '10.c non-wrap window respected');

    await fire.message({ type: 'rankpeek:start' });
    ok(env.store.sweep.dripMode === true, '10.1 sweep carries dripMode');
    ok(env.store.sweep.targets.length === 2, '10.1b targets present after shuffle');
    let tabId = env.store.sweep.current.tabId;
    const t0 = Date.now();
    let t = env.store.sweep.current.target;
    await fire.message({ type: 'rankpeek:serp', payload: { q: t.keyword, gl: t.gl, results: serpWithTarget(t.domain, 2) } }, { tab: { id: tabId } });
    const delay = env.store.sweep.nextAt - t0;
    const base = 4 * 60000;
    ok(delay >= 60000, '10.2 drip gap respects the 1/min floor', String(delay));
    ok(delay >= base * 0.6 && delay <= base * 1.4, '10.3 drip gap ≈ 4 min (jittered)', String(Math.round(delay / 60000)) + 'min');

    await fire.alarm('next'); // -> second target
    tabId = env.store.sweep.current.tabId;
    t = env.store.sweep.current.target;
    await fire.message({ type: 'rankpeek:serp', payload: { q: t.keyword, gl: t.gl, results: serpWithTarget(t.domain, 4) } }, { tab: { id: tabId } });
    const tabsBefore = env.calls.tabsCreated.length;
    await fire.alarm('next'); // list done -> drip should auto-restart a fresh cycle
    ok(env.store.sweep.running === true, '10.4 drip auto-restarts (still running after list end)');
    ok(env.store.sweep.index === 0, '10.5 restarted at index 0');
    ok(env.store.sweep.results.length <= 1, '10.6 results reset on new cycle');
    ok(env.calls.tabsCreated.length > tabsBefore, '10.7 new cycle opened a fresh tab');
  }

  // ---------------------------------------------------------------------
  section('10N. night pause gates queries during quiet hours');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [{ site: 'A', domain: 'a.com', keyword: 'A', gl: 'it', hl: 'it', geo: 'Italy' }];
    env.store.dripMode = true;
    // Quiet window that covers the ENTIRE day so "now" is always inside it.
    env.store.quietEnabled = true;
    env.store.quietStart = 0;
    env.store.quietEnd = 0; // start===end => inQuietHours returns false; use a full cover instead
    // Use a window [0.0001 .. 24) effectively: set start 0, end 23 won't cover 23:xx; instead force via a wide wrap.
    env.store.quietStart = 0;
    env.store.quietEnd = 23;
    // If the test happens to run 23:00-23:59 this would be active; acceptable edge. Assert only when quiet.
    await fire.message({ type: 'rankpeek:start' });
    const nowH = new Date().getHours();
    if (nowH < 23) {
      ok(env.store.sweep.quietPaused === true, '10N.1 quietPaused set during quiet hours');
      ok(env.calls.tabsCreated.length === 0, '10N.2 no query tab opened during night pause');
      ok(!!env.alarms.next, '10N.3 resume alarm scheduled for morning');
    } else {
      ok(true, '10N.1 skipped (edge hour 23:xx)');
      ok(true, '10N.2 skipped');
      ok(true, '10N.3 skipped');
    }
  }

  // ---------------------------------------------------------------------
  section('11. Daily report digest from lastChecks');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.telegramToken = 'TOK';
    env.store.telegramChatId = 'CHAT';
    env.store.alertMaxPos = 5;
    env.store.lastChecks = {
      'a.com|A|it': { site: 'A', geo: 'Italy', keyword: 'A', domain: 'a.com', gl: 'it', position: 2, yesterdayPosition: 3, error: null },
      'b.com|B|fr': { site: 'B', geo: 'France', keyword: 'B', domain: 'b.com', gl: 'fr', position: 8, yesterdayPosition: 4, error: null },
      'c.com|C|es': { site: 'C', geo: 'Spain', keyword: 'C', domain: 'c.com', gl: 'es', position: null, yesterdayPosition: 2, error: null },
    };
    await fire.alarm('dailyReport');
    const m = env.calls.tg.find((x) => x.includes('щоденний звіт'));
    ok(!!m, '11.1 daily report sent');
    ok(m && m.includes('<b>2</b>') && m.includes('поза топ-5'), '11.2 counts 2 sites out of top (B #8, C OUT)');
    ok(m && m.includes('France') && m.includes('#8'), '11.3 B listed, best #8');
    ok(m && m.includes('Spain') && m.includes('OUT'), '11.4 C shown as OUT');
    ok(!m || !m.includes('Italy'), '11.5 in-top A (Italy) not listed');

    // all-clear variant
    const env2 = makeEnv();
    loadBackground(env2);
    const fire2 = makeDriver(env2);
    env2.store.telegramToken = 'TOK';
    env2.store.telegramChatId = 'CHAT';
    env2.store.alertMaxPos = 5;
    env2.store.lastChecks = { 'a.com|A|it': { site: 'A', geo: 'Italy', keyword: 'A', domain: 'a.com', gl: 'it', position: 2, yesterdayPosition: 2, error: null } };
    await fire2.alarm('dailyReport');
    ok(env2.calls.tg.some((x) => x.includes('Проблемних нема')), '11.6 all-clear daily report');
  }

  // ---------------------------------------------------------------------
  section('12. Drop alerts: new drop in active brand top-10 -> Telegram, dedup, scope');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [
      { site: 'MyBrand', domain: 'mybrand-casino.com', keyword: 'mybrand', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'Other', domain: 'other-casino.com', keyword: 'other', gl: 'fr', hl: 'fr', geo: 'France' },
    ];
    env.store.dropWatch = ['mybrand-casino.com']; // only MyBrand is "active"
    env.store.telegramToken = 'TOK';
    env.store.telegramChatId = 'CHAT';
    env.store.digestEveryRun = false; // isolate: only drop alerts in the stream

    // Drops are identified by the ᐉ stencil title ("<Brand> Official Site ᐉ <Brand> Login").
    const withTitles = (arr) =>
      arr.map((x, i) => ({ host: x.host, position: i + 1, url: `https://${x.host}/`, title: x.title || x.host }));
    const serpFor = (t) =>
      t.domain === 'mybrand-casino.com'
        ? withTitles([
            { host: 'mybrand-casino.com', title: 'MyBrand Casino' }, // you
            { host: 'beachxbums.com', title: 'MyBrand Sitio Oficial ᐉ MyBrand Acceso' }, // DROP (stencil)
            { host: 'megaslots-casino.com', title: 'MegaSlots real casino' }, // competitor, no stencil
            { host: 'trustpilot.com', title: 'Reviews ᐉ Top Bonuses' }, // has ᐉ but NOT a stencil
            { host: 'hanami-sushi.it', title: 'MyBrand Official Site ᐉ MyBrand Login' }, // DROP (stencil)
          ])
        : withTitles([
            { host: 'other-casino.com', title: 'Other' },
            { host: 'santinavarro.com', title: 'Other Official Site ᐉ Other Login' }, // a stencil, but this brand isn't active
          ]);

    // run1: two new drops on the active brand -> one alert listing both; none for Other
    await runSweep(env, fire, serpFor);
    let tg = env.calls.tg.slice();
    const d1 = tg.filter((m) => m.includes('Нові дропи'));
    ok(d1.length === 1, '12.1 exactly one drop alert (active brand only)', String(d1.length));
    ok(d1[0] && d1[0].includes('beachxbums.com') && d1[0].includes('hanami-sushi.it'), '12.2 alert lists both new drops');
    ok(d1[0] && !d1[0].includes('megaslots-casino.com') && !d1[0].includes('trustpilot.com'), '12.3 competitor + aggregator are NOT flagged as drops');
    ok(!tg.some((m) => m.includes('santinavarro.com')), '12.4 a drop on a NON-active brand does not alert');

    // run2: same drops -> no new alert (dedup on persisting drops)
    env.calls.tg.length = 0;
    await runSweep(env, fire, serpFor);
    ok(!env.calls.tg.some((m) => m.includes('Нові дропи')), '12.5 persisting drops are not re-alerted');

    // run3: a NEW drop appears -> alert only for the newly-appeared one
    env.calls.tg.length = 0;
    const serpFor2 = (t) =>
      t.domain === 'mybrand-casino.com'
        ? withTitles([
            { host: 'mybrand-casino.com', title: 'MyBrand Casino' },
            { host: 'beachxbums.com', title: 'MyBrand Sitio Oficial ᐉ MyBrand Acceso' },
            { host: 'hanami-sushi.it', title: 'MyBrand Official Site ᐉ MyBrand Login' },
            { host: 'newdrop-bakery.org', title: 'MyBrand Official Site ᐉ MyBrand Login' }, // NEW drop (stencil)
          ])
        : withTitles([{ host: 'other-casino.com', title: 'Other' }]);
    await runSweep(env, fire, serpFor2);
    const d3 = env.calls.tg.slice().filter((m) => m.includes('Нові дропи'));
    ok(d3.length === 1 && d3[0].includes('newdrop-bakery.org') && !d3[0].includes('beachxbums.com'), '12.6 only the newly-appeared drop is alerted');

    // toggle OFF suppresses drop alerts
    const env3 = makeEnv();
    loadBackground(env3);
    const fire3 = makeDriver(env3);
    env3.store.sweepTargets = [{ site: 'MyBrand', domain: 'mybrand-casino.com', keyword: 'mybrand', gl: 'it', hl: 'it', geo: 'Italy' }];
    env3.store.dropWatch = ['mybrand-casino.com'];
    env3.store.telegramToken = 'TOK';
    env3.store.telegramChatId = 'CHAT';
    env3.store.digestEveryRun = false;
    env3.store.dropAlerts = false; // OFF
    await runSweep(env3, fire3, () => withTitles([{ host: 'mybrand-casino.com', title: 'MyBrand' }, { host: 'beachxbums.com', title: 'MyBrand Official Site ᐉ MyBrand Login' }]));
    ok(!env3.calls.tg.some((m) => m.includes('Нові дропи')), '12.7 dropAlerts=false suppresses drop alerts (marker drop present but muted)');
  }

  // ---------------------------------------------------------------------
  section('13. Active-brand sweep: separate faster pass over only the dropWatch list');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [
      { site: 'Act1', domain: 'act1-casino.com', keyword: 'act1', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'Act2', domain: 'act2-casino.com', keyword: 'act2', gl: 'es', hl: 'es', geo: 'Spain' },
      { site: 'Big', domain: 'big-casino.com', keyword: 'big', gl: 'fr', hl: 'fr', geo: 'France' },
    ];
    env.store.dropWatch = ['act1-casino.com', 'act2-casino.com']; // 2 active brands
    env.store.activeSweep = true;
    env.store.activeSweepHours = 2;
    env.store.stepDelaySec = 3;

    // applySchedule (via rankpeek:schedule) arms the activeSweep alarm
    await fire.message({ type: 'rankpeek:schedule' });
    ok(!!env.alarms.activeSweep, '13.1 activeSweep alarm armed when the setting is on');

    // firing it starts a sweep scoped to ONLY the active brands
    await fire.alarm('activeSweep');
    const swept = [];
    let guard = 0;
    while (env.store.sweep && env.store.sweep.running && guard < 200) {
      guard += 1;
      const s = env.store.sweep;
      if (s.paused) break;
      if (!s.current) {
        if (env.alarms.next) { await fire.alarm('next'); continue; }
        break;
      }
      const t = s.current.target;
      swept.push(t.domain);
      await fire.message(
        { type: 'rankpeek:serp', payload: { q: t.keyword, gl: t.gl, results: serpWithTarget(t.domain, 1) } },
        { tab: { id: s.current.tabId } },
      );
      if (env.alarms.next) await fire.alarm('next');
    }
    const uniq = [...new Set(swept)].sort();
    ok(uniq.length === 2 && uniq[0] === 'act1-casino.com' && uniq[1] === 'act2-casino.com', '13.2 scoped sweep hits ONLY the 2 active brands (Big excluded)', JSON.stringify(uniq));
    ok(env.store.sweep && env.store.sweep.scope === 'active', '13.3 sweep tagged scope=active');

    // idle guard: activeSweep does NOT start when a sweep is already running
    env.store.sweep = { running: true, scope: 'all', targets: [], index: 0, current: null };
    const before = JSON.stringify(env.store.sweep);
    await fire.alarm('activeSweep');
    ok(JSON.stringify(env.store.sweep) === before, '13.4 activeSweep skipped while another sweep is running');

    // empty active list -> the scoped sweep is a no-op (nothing to check)
    const env2 = makeEnv();
    loadBackground(env2);
    const fire2 = makeDriver(env2);
    env2.store.sweepTargets = [{ site: 'Big', domain: 'big-casino.com', keyword: 'big', gl: 'fr', hl: 'fr', geo: 'France' }];
    env2.store.dropWatch = []; // none active
    await fire2.alarm('activeSweep');
    ok(!env2.store.sweep || !env2.store.sweep.running, '13.5 no active brands -> active sweep does not start');
  }

  // ---------------------------------------------------------------------
  section('14. Manual "run drops" trigger (rankpeek:startActive)');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    env.store.sweepTargets = [
      { site: 'Act', domain: 'act-casino.com', keyword: 'act', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'Big', domain: 'big-casino.com', keyword: 'big', gl: 'fr', hl: 'fr', geo: 'France' },
    ];
    env.store.dropWatch = ['act-casino.com'];

    // idle + active brand set -> manual trigger starts a scoped active sweep
    await fire.message({ type: 'rankpeek:startActive' });
    ok(env.store.sweep && env.store.sweep.running && env.store.sweep.scope === 'active', '14.1 manual trigger starts a scoped active sweep');
    ok(env.store.sweep.targets.length === 1 && env.store.sweep.targets[0].domain === 'act-casino.com', '14.2 scoped to active brands only (Big excluded)');

    // while a sweep is running -> ignored (no change)
    const snap = JSON.stringify(env.store.sweep);
    await fire.message({ type: 'rankpeek:startActive' });
    ok(JSON.stringify(env.store.sweep) === snap, '14.3 ignored while a sweep is already running');

    // empty active list -> nothing starts
    const env2 = makeEnv();
    loadBackground(env2);
    const fire2 = makeDriver(env2);
    env2.store.sweepTargets = [{ site: 'Big', domain: 'big-casino.com', keyword: 'big', gl: 'fr', hl: 'fr', geo: 'France' }];
    env2.store.dropWatch = [];
    await fire2.message({ type: 'rankpeek:startActive' });
    ok(!env2.store.sweep || !env2.store.sweep.running, '14.4 empty active list -> nothing starts');
  }

  // ---------------------------------------------------------------------
  section('15. Active sweep uses FULL drops targets directly (not limited to the main list)');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    // main list has only Big; the drops watchlist carries two brands NOT in it,
    // each with its own keyword + geo (the full-CSV format)
    env.store.sweepTargets = [{ site: 'Big', domain: 'big-casino.com', keyword: 'big', gl: 'fr', hl: 'fr', geo: 'France' }];
    env.store.dropWatch = [
      { site: 'Winner', domain: 'winnercasino-it.com', keyword: 'winner', gl: 'it', hl: 'it', geo: 'Italy' },
      { site: 'Twin', domain: 'twincasinos-pt.com', keyword: 'twin', gl: 'pt', hl: 'pt', geo: 'Portugal' },
    ];
    await fire.alarm('activeSweep');
    const swept = [];
    let guard = 0;
    while (env.store.sweep && env.store.sweep.running && guard < 200) {
      guard += 1;
      const s = env.store.sweep;
      if (s.paused) break;
      if (!s.current) {
        if (env.alarms.next) { await fire.alarm('next'); continue; }
        break;
      }
      const t = s.current.target;
      swept.push(t.domain);
      await fire.message(
        { type: 'rankpeek:serp', payload: { q: t.keyword, gl: t.gl, results: serpWithTarget(t.domain, 1) } },
        { tab: { id: s.current.tabId } },
      );
      if (env.alarms.next) await fire.alarm('next');
    }
    const uniq = [...new Set(swept)].sort();
    ok(uniq.length === 2 && uniq.includes('winnercasino-it.com') && uniq.includes('twincasinos-pt.com'), '15.1 active sweep checks the full drops targets even though they are NOT in the main list', JSON.stringify(uniq));
    ok(!uniq.includes('big-casino.com'), '15.2 a main-list brand not in the drops watchlist is not swept by the active pass');
  }

  // ---------------------------------------------------------------------
  section('16. Telegram test surfaces the real error (chat not found)');
  {
    const env = makeEnv();
    loadBackground(env);
    // success path
    env.store.telegramToken = 'TOK';
    env.store.telegramChatId = 'GOODCHAT';
    let okResp;
    env.listeners.message.forEach((fn) => fn({ type: 'rankpeek:testTg' }, {}, (r) => { okResp = r; }));
    await flush();
    ok(okResp && okResp.ok === true, '16.1 valid setup -> {ok:true}');

    // failure path: Telegram says "chat not found" -> surfaced verbatim
    env.store.telegramChatId = 'BADCHAT';
    let badResp;
    env.listeners.message.forEach((fn) => fn({ type: 'rankpeek:testTg' }, {}, (r) => { badResp = r; }));
    await flush();
    ok(badResp && badResp.ok === false && /chat not found/i.test(badResp.error || ''), '16.2 failure returns the real Telegram reason', JSON.stringify(badResp));

    // empty creds -> clear message, no fetch
    env.store.telegramToken = '';
    let emptyResp;
    env.listeners.message.forEach((fn) => fn({ type: 'rankpeek:testTg' }, {}, (r) => { emptyResp = r; }));
    await flush();
    ok(emptyResp && emptyResp.ok === false, '16.3 empty token/chat_id -> {ok:false}');
  }

  // ---------------------------------------------------------------------
  section('17. Google Sheet sync: tabs -> active-brand drops (exact domains)');
  {
    const env = makeEnv();
    const ctx = loadBackground(env);

    const H = ['domain', 'brand', 'Type', 'geo'];
    // parseSheetGrids directly: "*"-in-name tab active; plain tab inactive; flag-column tab partial
    const titles = ['Gamblerina FR *', '20bet IT', 'hahaspin ES'];
    const grids = {
      'Gamblerina FR *': [H, ['meuse-internet.fr', 'Gamblerina', 'monobrand', 'FR'], ['carpes-koi.fr', 'Gamblerina', 'monobrand', 'FR']],
      '20bet IT': [H, ['somedrop.it', '20bet', 'monobrand', 'IT']], // no "*" -> skipped
      'hahaspin ES': [['domain', 'brand', 'Type', 'geo', 'check'], ['drop1.es', 'Hahaspin', 'monobrand', 'ES', '*'], ['drop2.es', 'Hahaspin', 'monobrand', 'ES', '']],
    };
    const parsed = ctx.parseSheetGrids(titles, titles.map((t) => ({ values: grids[t] })));
    // 2 active projects × 2 queries each (brand + "brand casino"); 20bet IT skipped
    ok(parsed.targets.length === 4 && parsed.stats.projects === 2, '17.1 two active projects, two queries each', String(parsed.targets.length));
    const gam = parsed.targets.filter((t) => t.site === 'Gamblerina');
    ok(gam.length === 2 && gam.some((t) => t.keyword === 'Gamblerina') && gam.some((t) => t.keyword === 'Gamblerina casino'), '17.2a queries = «brand» + «brand casino»');
    ok(gam[0].gl === 'fr' && gam[0].source === 'sheet', '17.2b project target has gl + source=sheet');
    ok(parsed.drops[gam[0].domain].length === 2 && parsed.drops[gam[0].domain].includes('meuse-internet.fr'), '17.3 exact drop domains captured per project');
    // extra='' -> brand only
    const bare = ctx.parseSheetGrids(titles, titles.map((t) => ({ values: grids[t] })), '');
    ok(bare.targets.length === 2 && bare.targets.every((t) => !/ casino$/.test(t.keyword)), '17.3b empty extra -> brand-only query');
    const hah = parsed.targets.find((t) => t.site === 'Hahaspin');
    ok(hah && parsed.drops[hah.domain].length === 1 && parsed.drops[hah.domain][0] === 'drop1.es', '17.4 flag column: only "*"-marked row active');
    ok(!parsed.targets.some((t) => t.site === '20bet'), '17.5 tab without "*" not tracked');

    // full syncSheet flow via the API mock + rankpeek:syncSheet
    env.store.__sheet = { titles, grids };
    env.store.sheetId = 'https://docs.google.com/spreadsheets/d/ABC123456789012345678901/edit';
    env.store.sheetApiKey = 'AIzaTESTKEY';
    const fire = makeDriver(env);
    let resp;
    env.listeners.message.forEach((fn) => fn({ type: 'rankpeek:syncSheet' }, {}, (r) => { resp = r; }));
    await flush();
    ok(resp && resp.ok && resp.projects === 2 && resp.queries === 4 && resp.drops === 3, '17.6 syncSheet ok: 2 projects, 4 queries, 3 drops', JSON.stringify(resp));
    ok(Array.isArray(env.store.dropWatch) && env.store.dropWatch.length === 4, '17.7 dropWatch populated (2 projects × 2 queries)');
    ok(env.store.sheetDrops && Object.keys(env.store.sheetDrops).length === 2, '17.8 sheetDrops (exact domains) stored');

    // no API key -> clear error, no crash
    const env2 = makeEnv();
    loadBackground(env2);
    env2.store.sheetId = 'ABC123456789012345678901';
    let resp2;
    env2.listeners.message.forEach((fn) => fn({ type: 'rankpeek:syncSheet' }, {}, (r) => { resp2 = r; }));
    await flush();
    ok(resp2 && resp2.ok === false && /ключ/i.test(resp2.error || ''), '17.9 missing API key -> clear error');
  }

  // ---------------------------------------------------------------------
  section('18. Exact known-drop alert (from the sheet) + no site-position spam');
  {
    const env = makeEnv();
    loadBackground(env);
    const fire = makeDriver(env);
    // one sheet project: brand "Gamblerina" FR, known drop meuse-internet.fr
    const pd = 'gamblerina.fr.drops';
    env.store.sweepTargets = [{ site: 'Gamblerina', domain: pd, keyword: 'Gamblerina', gl: 'fr', hl: 'fr', geo: 'FR', source: 'sheet' }];
    env.store.dropWatch = env.store.sweepTargets.slice();
    env.store.sheetDrops = { [pd]: ['meuse-internet.fr'] };
    env.store.telegramToken = 'TOK';
    env.store.telegramChatId = 'CHAT';
    env.store.digestEveryRun = false;

    // SERP where the known drop ranks #3 (title has NO ᐉ stencil — pure exact match)
    const serpFor = () => serp([
      { host: 'superbet.fr' }, { host: 'somereview.fr' }, { host: 'meuse-internet.fr' }, { host: 'wikipedia.org' },
    ]);
    await runSweep(env, fire, serpFor);
    const tg = env.calls.tg.slice();
    ok(tg.some((m) => m.includes('Нові дропи') && m.includes('meuse-internet.fr')), '18.1 exact known drop alerted even without an ᐉ stencil');
    ok(!tg.some((m) => m.includes('Випав із топ')), '18.2 sheet project does NOT trigger site-out-of-top alerts');
  }

  // done
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

// helper to keep advancing after a manual resume in test 5
async function runSweep2Continue(env, fire) {
  let guard = 0;
  while (env.store.sweep && env.store.sweep.running && guard < 100) {
    guard += 1;
    const s = env.store.sweep;
    if (s.paused) break;
    if (!s.current) {
      if (env.alarms.next) { await fire.alarm('next'); continue; }
      break;
    }
    const t = s.current.target;
    const tabId = s.current.tabId;
    await fire.message(
      { type: 'rankpeek:serp', payload: { q: t.keyword, gl: t.gl, results: serpWithTarget(t.domain, 3) } },
      { tab: { id: tabId } },
    );
    if (env.alarms.next) await fire.alarm('next');
  }
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exitCode = 2;
});
