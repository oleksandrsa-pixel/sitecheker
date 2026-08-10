// Rank Peek — background sweep orchestrator (MV3 service worker).
//
// Drives the tracked-target list through Google ONE query at a time, at a
// human pace, in background tabs that use the USER'S own session/login/geo,
// reads each SERP via the content script, and POSTs each result to the tracker
// ingest endpoint. Alarms are used so the sweep survives service-worker
// suspension between steps.
//
// Anti-block behaviour (v0.3):
//   - Human pacing with random jitter on every gap between queries.
//   - A long "batch break" every N queries so a run of ~200 targets is not one
//     uninterrupted burst (that is what trips Google's rate limits).
//   - Block detection: if Google shows a CAPTCHA / "sorry" interstitial /
//     consent wall (detected by tab URL or by the content script), the sweep
//     PAUSES on that target, brings the challenge tab to the front so the user
//     can solve it once by hand, and resumes automatically afterwards. If the
//     user is away, it auto-retries the same target after a cooldown.
//   - Repeated silent failures (timeouts) are treated as a soft block and also
//     trigger a cooldown instead of blindly continuing.

const DEFAULT_INGEST = 'http://127.0.0.1:33000/ingest/serp';
const DEFAULT_STEP_DELAY_SEC = 20; // human pace between queries (configurable)
const DEFAULT_BATCH_SIZE = 20; // long break after this many queries
const DEFAULT_BATCH_PAUSE_SEC = 180; // length of that long break
const DEFAULT_COOLDOWN_MIN = 30; // wait after a block before auto-retry
const RESULT_TIMEOUT_MS = 22_000; // abandon a query with no result after this
const SOFT_FAIL_LIMIT = 2; // consecutive errors that look like a soft block
const DEFAULT_DRIP_GAP_MIN = 4; // drip mode: minutes between queries (jittered ~3-5)
const DRIP_MIN_GAP_MS = 60_000; // never faster than 1/min even if misconfigured
const DEFAULT_DAILY_REPORT_HOUR = 9; // daily Telegram report time (local)
const DEFAULT_ACTIVE_SWEEP_HOURS = 2; // separate faster pass over active brands
const DEFAULT_QUIET_START = 23; // night pause start (local hour)
const DEFAULT_QUIET_END = 7; // night pause end (local hour) -> ~16h active window

// One row per (site x keyword x geo). gl = country, hl = local language.
const DEFAULT_TARGETS = [
  { site: 'Betscore', domain: 'betscore-1casino.com', keyword: 'Betscore', gl: 'it', hl: 'it', geo: 'Italy' },
  { site: 'Betscore', domain: 'betscore-1casino.com', keyword: 'Betscore casino', gl: 'it', hl: 'it', geo: 'Italy' },
  { site: 'Casea', domain: 'casea-casino1.com', keyword: 'Casea', gl: 'gr', hl: 'el', geo: 'Greece' },
  { site: 'Casea', domain: 'casea-casino1.com', keyword: 'Casea casino', gl: 'gr', hl: 'el', geo: 'Greece' },
  { site: 'Magneticslots', domain: 'magneticslotcasino.com', keyword: 'Magneticslots', gl: 'pt', hl: 'pt', geo: 'Portugal' },
  { site: 'Magneticslots', domain: 'magneticslotcasino.com', keyword: 'Magneticslots casino', gl: 'pt', hl: 'pt', geo: 'Portugal' },
  { site: 'Nvcasino', domain: 'nvcasino-frances.com', keyword: 'Nvcasino', gl: 'fr', hl: 'fr', geo: 'France' },
  { site: 'Nvcasino', domain: 'nvcasino-frances.com', keyword: 'Nvcasino casino', gl: 'fr', hl: 'fr', geo: 'France' },
  { site: 'Casea', domain: 'casea-online-casino.com', keyword: 'Casea', gl: 'es', hl: 'es', geo: 'Spain' },
  { site: 'Casea', domain: 'casea-online-casino.com', keyword: 'Casea casino', gl: 'es', hl: 'es', geo: 'Spain' },
];

const registrable = (h) => (h || '').replace(/^www\./, '').toLowerCase();
const matchHost = (host, target) => {
  const h = registrable(host);
  const t = registrable(target);
  return Boolean(h) && Boolean(t) && (h === t || h.endsWith('.' + t));
};

// Aggregators / platforms that are not direct competitors — filtered out of the
// per-target competitor list.
const NOISE = [
  'wikipedia.org', 'trustpilot.com', 'google.com', 'apps.apple.com', 'youtube.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'reddit.com', 'tiktok.com',
  'linkedin.com', 'pinterest.com', 'tripadvisor.com',
];
const isNoise = (host) => NOISE.some((n) => matchHost(host, n));
const isOwn = (host, ownDomains) => (ownDomains || []).some((d) => matchHost(host, d));

// Drop detection (mirror of drops.js). Drops share a stencil SERP <title>:
// "<Brand> Official Site ᐉ <Brand> Login" (localized), e.g. "Casea Official Site
// ᐉ Casea Login". The ᐉ (U+1409) marker alone is not enough — some legit sites
// use it — so a title counts as a drop only when it ALSO matches one structural
// signal of the stencil (brand repeated around the marker / on both sides, or the
// localized official+login phrases). `brand` = the tracked keyword.
const DROP_MARKERS = ['ᐉ']; // ᐉ CANADIAN SYLLABICS PWO
const OFFICIAL_RE = /(official|oficial|officiel|ufficiale|offiziell|oficjaln|επισημ|επίσημ)/;
const ACCESS_RE = /(\blogin\b|\blog[\s-]?in\b|\bacceso\b|\bacesso\b|\baccesso\b|\bacc[eè]s\b|\bentrar\b|\bentrada\b|\bingresar\b|\bconnexion\b|\baccedi\b|\banmeld|\binloggen\b|εισοδ|είσοδ)/;
const firstToken = (s) => {
  const m = String(s || '').toLowerCase().match(/[a-z0-9]+/);
  return m ? m[0] : '';
};
const foldText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Brand-anchored stencil test — identical to drops.js isDropTitle. Requires the
// ᐉ marker AND the tracked brand on both sides of it, OR the brand present plus
// the official(left)+login(right) phrase layout. Keeps out random ᐉ sites.
function isDropTitle(title, brand) {
  const t = String(title || '');
  const marker = DROP_MARKERS.find((m) => t.includes(m));
  if (!marker) return false; // the ᐉ marker is required
  const b = firstToken(brand);
  if (!b || b.length < 2) return false; // the brand is the anchor
  const i = t.indexOf(marker);
  const left = foldText(t.slice(0, i));
  const right = foldText(t.slice(i + marker.length));
  const bre = new RegExp('(^|[^a-z0-9])' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)');
  const onLeft = bre.test(left);
  const onRight = bre.test(right);
  if (onLeft && onRight) return true; // brand copied on both sides of ᐉ
  if ((onLeft || onRight) && OFFICIAL_RE.test(left) && ACCESS_RE.test(right)) return true; // brand + stencil layout
  return false;
}
const isDrop = (entry, ownDomains, brand) =>
  isDropTitle(entry && entry.title, brand) && !isOwn(entry && entry.host, ownDomains);

// The active-brand watchlist (dropWatch) is a full target list (Domain, keyword,
// GEO) — same shape as sweepTargets — so the active sweep can check every
// drop-brand directly. Legacy saves may be plain domain strings.
const watchTargets = (list) =>
  (list || []).filter((x) => x && typeof x === 'object' && x.domain && x.keyword && x.gl && x.hl);
function watchDomains(list) {
  const out = [];
  const seen = new Set();
  for (const x of list || []) {
    const d = registrable(typeof x === 'string' ? x : x && x.domain);
    if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);

// Random jitter so gaps between queries never look mechanical (±35%).
const jitter = (ms) => Math.round(ms * (0.65 + Math.random() * 0.7));

// Fisher-Yates shuffle — randomize target order each pass so the query stream
// isn't a fixed "same brands, gl/hl flipped per row" rank-tracker signature.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// Night pause: is `d` inside the quiet window [start,end) in local hours?
// Handles wrap-around (e.g. 23 -> 7).
function inQuietHours(d, start, end) {
  if (start === end) return false;
  const h = d.getHours() + d.getMinutes() / 60;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

// Ms from `d` until the next local `end` o'clock (when the quiet window lifts).
function msUntilQuietEnd(d, end) {
  const t = new Date(d);
  t.setHours(end, 0, 0, 0);
  if (t <= d) t.setDate(t.getDate() + 1);
  return t - d;
}

// URL patterns that mean "Google is challenging us, not serving results".
const isBlockUrl = (u) =>
  /\/sorry\//i.test(u || '') ||
  /consent\.google\./i.test(u || '') ||
  /\/interstitial/i.test(u || '');

const getSweep = async () => (await chrome.storage.local.get('sweep')).sweep;
const setSweep = async (s) => chrome.storage.local.set({ sweep: s });

function validTargets(list) {
  return (
    Array.isArray(list) &&
    list.length > 0 &&
    list.every(
      (t) => t && typeof t === 'object' && t.domain && t.keyword && t.gl && t.hl,
    )
  );
}

async function getConfig() {
  // NOTE: dedicated key `sweepTargets` (objects) — separate from the overlay's
  // legacy `targets` (domain strings) to avoid a shape collision.
  const v = await chrome.storage.local.get([
    'sweepTargets',
    'ingestUrl',
    'stepDelaySec',
    'batchSize',
    'batchPauseSec',
    'cooldownMin',
    'dripMode',
    'dripGapMin',
    'quietEnabled',
    'quietStart',
    'quietEnd',
  ]);
  const delaySec = Math.max(3, Number(v.stepDelaySec) || DEFAULT_STEP_DELAY_SEC);
  return {
    targets: validTargets(v.sweepTargets) ? v.sweepTargets : DEFAULT_TARGETS,
    ingestUrl: v.ingestUrl || DEFAULT_INGEST,
    stepDelayMs: delaySec * 1000,
    batchSize: Math.max(0, Number(v.batchSize) || DEFAULT_BATCH_SIZE),
    batchPauseMs: Math.max(30, Number(v.batchPauseSec) || DEFAULT_BATCH_PAUSE_SEC) * 1000,
    cooldownMs: Math.max(1, Number(v.cooldownMin) || DEFAULT_COOLDOWN_MIN) * 60_000,
    dripMode: Boolean(v.dripMode),
    dripGapMs: Math.max(1, Number(v.dripGapMin) || DEFAULT_DRIP_GAP_MIN) * 60_000,
    quietEnabled: Boolean(v.quietEnabled),
    quietStart: Number.isFinite(Number(v.quietStart)) ? Number(v.quietStart) : DEFAULT_QUIET_START,
    quietEnd: Number.isFinite(Number(v.quietEnd)) ? Number(v.quietEnd) : DEFAULT_QUIET_END,
  };
}

// ---- Telegram alerting -----------------------------------------------------

async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Send a test message and return the REAL reason on failure, so the popup can
// tell the user exactly what's wrong (Telegram's own description) instead of a
// generic "check token / chat_id". Most common: "chat not found" = the user
// never pressed Start in the bot, or the chat_id is wrong.
async function telegramTest(token, chatId) {
  if (!token || !chatId) return { ok: false, error: 'Порожній token або chat_id' };
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ Rank Peek підключено. Сюди приходитимуть алерти про падіння сайтів і дропи.',
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    // Fetch itself failed — network / DNS / Telegram blocked on this connection.
    return { ok: false, error: 'мережа: не вдалося зʼєднатися з api.telegram.org (' + ((e && e.message) || 'fetch failed') + ')' };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (res.ok && data && data.ok) return { ok: true };
  const desc = (data && data.description) || `HTTP ${res.status}`;
  return { ok: false, error: String(desc) };
}

// Split a long Telegram message into <=limit chunks on line boundaries.
async function sendTelegramChunked(token, chatId, text) {
  const LIMIT = 3500;
  if (text.length <= LIMIT) return sendTelegram(token, chatId, text);
  const lines = text.split('\n');
  let buf = '';
  for (const ln of lines) {
    if ((buf + '\n' + ln).length > LIMIT && buf) {
      await sendTelegram(token, chatId, buf);
      buf = ln;
    } else {
      buf = buf ? buf + '\n' + ln : ln;
    }
  }
  if (buf) await sendTelegram(token, chatId, buf);
  return true;
}

// Short human-readable "now" for message footers.
function fmtNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Compact trend marker comparing a previous position to the current one.
// Lower number = better rank, so cur < prev means improvement.
function trendText(prev, cur) {
  if (prev === undefined) return '🆕';
  if (cur == null) return prev == null ? '(досі поза)' : `🔴 впав із #${prev}`;
  if (prev == null) return '🟢 повернувся';
  if (cur < prev) return `🟢▲${prev - cur}`;
  if (cur > prev) return `🔴▼${cur - prev}`;
  return '=';
}

// Latest history entry that is at least `agoMs` old (e.g. ~24h ago).
function positionAround(hist, agoMs) {
  const cutoff = Date.now() - agoMs;
  let found;
  for (const h of hist) {
    const t = new Date(h.at).getTime();
    if (!Number.isNaN(t) && t <= cutoff) found = h;
  }
  return found ? found.pos : undefined;
}

// Aggregate the per-keyword checks into a per-SITE view (one site = one
// domain+geo). A site counts as "in top" if it ranks <= maxPos by AT LEAST ONE
// of its keywords; it's "out" only when ALL its keywords are out. Status:
//   'in'      — at least one keyword in top-N
//   'out'     — every keyword out of top-N (and all configured keywords checked)
//   'pending' — not all configured keywords checked yet (don't judge/alert)
//   'unknown' — only errors so far
function siteAggregate(lastChecks, sweepTargets, maxPos) {
  // configured keyword set per site (so a partial check isn't judged as "out")
  const configured = new Map();
  for (const t of sweepTargets || []) {
    if (!t || !t.domain || !t.gl) continue;
    const k = `${registrable(t.domain)}|${t.gl}`;
    if (!configured.has(k)) configured.set(k, new Set());
    configured.get(k).add(t.keyword);
  }
  const sites = new Map();
  for (const c of Object.values(lastChecks || {})) {
    if (!c || !c.domain) continue;
    const k = `${registrable(c.domain)}|${c.gl || ''}`;
    if (!sites.has(k)) {
      sites.set(k, {
        key: k,
        site: c.site || registrable(c.domain),
        geo: c.geo || (c.gl ? c.gl.toUpperCase() : ''),
        domain: registrable(c.domain),
        gl: c.gl || '',
        entries: [],
      });
    }
    sites.get(k).entries.push(c);
  }
  const out = [];
  for (const [k, s] of sites) {
    const nonErr = s.entries.filter((e) => !e.error);
    const cfg = configured.get(k);
    const checked = new Set(s.entries.map((e) => e.keyword));
    const allChecked = cfg ? [...cfg].every((kw) => checked.has(kw)) : true;
    let status;
    if (!nonErr.length) status = 'unknown';
    else if (nonErr.some((e) => e.position != null && e.position <= maxPos)) status = 'in';
    else if (cfg && !allChecked) status = 'pending';
    else status = 'out';
    const positions = nonErr.map((e) => e.position).filter((p) => typeof p === 'number');
    out.push({ ...s, status, bestPos: positions.length ? Math.min(...positions) : null });
  }
  return out;
}

// Per-SITE transition alert: fire only when a site crosses in<->out (out = it
// fell out of top-N by ALL its keywords). If it still ranks by at least one
// keyword, stay silent. Baseline (first definitive status) never alerts.
async function maybeAlertSite(s, result) {
  if (result.error) return; // a single keyword's technical failure isn't a drop
  const maxPos = s.alertMaxPos ?? 5;
  const data = await chrome.storage.local.get(['lastChecks', 'sweepTargets', 'siteStatus']);
  const key = `${registrable(result.domain)}|${result.gl}`;
  const site = siteAggregate(data.lastChecks || {}, data.sweepTargets || [], maxPos).find(
    (x) => x.key === key,
  );
  if (!site || site.status === 'pending' || site.status === 'unknown') return;

  const store = data.siteStatus || {};
  const prev = store[key]; // 'in' | 'out' | undefined
  store[key] = site.status;
  await chrome.storage.local.set({ siteStatus: store });
  if (prev === undefined || prev === site.status) return; // baseline / no change

  const bestTxt = site.bestPos != null ? `#${site.bestPos}` : 'немає у видачі';
  let msg = null;
  if (site.status === 'out') {
    msg =
      `🔴 <b>${site.site}</b> · ${site.geo}\n` +
      `Випав із топ-${maxPos} по ВСІХ ключах\n` +
      `Найкраща позиція: ${bestTxt}\n🕒 ${result.collectedAt}\nhttps://${site.domain}`;
  } else if (site.status === 'in') {
    msg = `🟢 <b>${site.site}</b> · ${site.geo}\nЗнову в топ-${maxPos}: ${bestTxt}\n🕒 ${result.collectedAt}`;
  }
  if (msg) await sendTelegram(s.telegramToken, s.telegramChatId, msg);
}

// Per-QUERY drop alert: notify when a NEW drop domain appears in the top-10 of
// one of your ACTIVE brands (the dropWatch list you manage on the Drops tab).
// Only fires for active brands; a drop that persists across runs is not
// re-alerted (only its first appearance). Empty active list = no drop alerts.
async function maybeAlertDrops(s, result) {
  if (result.error) return;
  if (!s.telegramToken || !s.telegramChatId) return;
  const data = await chrome.storage.local.get(['dropWatch', 'dropsSeen', 'dropAlerts']);
  if (data.dropAlerts === false) return; // toggle, default ON
  const domains = watchDomains(data.dropWatch);
  if (!domains.length) return; // no active brands defined -> nothing to watch
  if (!domains.some((d) => matchHost(result.domain, d))) return; // this brand isn't active

  const ownDomains = (s.targets || []).map((t) => t.domain);
  const brand = result.keyword || result.site;
  const currentDrops = (result.topResults || [])
    .slice(0, 10)
    .filter((x) => isDrop(x, ownDomains, brand));
  const currentHosts = currentDrops.map((x) => registrable(x.host));

  const key = `${result.domain}|${result.keyword}|${result.gl}`;
  const store = data.dropsSeen || {};
  const prevSeen = Array.isArray(store[key]) ? store[key] : [];
  store[key] = currentHosts; // remember for next run (so persisting drops don't re-alert)
  await chrome.storage.local.set({ dropsSeen: store });

  const fresh = currentDrops.filter((x) => !prevSeen.includes(registrable(x.host)));
  if (!fresh.length) return;

  const lines = fresh.map(
    (x) => `#${x.position} ${registrable(x.host)}\n${x.url || 'https://' + registrable(x.host)}`,
  );
  const msg =
    `🎯 <b>${result.site}</b> · ${result.geo || result.gl} · «${result.keyword}»\n` +
    `Нові дропи в топ-10 (${fresh.length}):\n` +
    lines.join('\n') +
    `\n🕒 ${result.collectedAt}`;
  await sendTelegramChunked(s.telegramToken, s.telegramChatId, msg);
}

// One day in ms — the window used for the "yesterday" comparison.
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_CAP = 60; // keep the last N readings per target

// Persist the last check (position + timestamp) per target so the popup and the
// report page can show "last run" for each site even between sweeps. Also keep a
// rolling per-target history so the report can show previous / yesterday /
// trend, and store those derived values on the check for convenience.
async function updateLastCheck(result, ownDomains = []) {
  const key = `${result.domain}|${result.keyword}|${result.gl}`;
  const data = await chrome.storage.local.get(['lastChecks', 'history']);
  const checks = data.lastChecks || {};
  const histAll = data.history || {};
  const hist = histAll[key] || [];
  const base = checks[key] || {};

  // Computed from the history that existed BEFORE this reading is appended.
  const prevEntry = hist.length ? hist[hist.length - 1] : null;
  const prevPosition = prevEntry ? prevEntry.pos : undefined;
  const yesterdayPosition = positionAround(hist, DAY_MS);

  const top1 = (result.topResults && result.topResults[0] && result.topResults[0].host) || null;

  // Full top-10 SERP kept per target so the Competitors tab can show the WHOLE
  // ranking around our site (own flagged), with full URLs. `own` = the host is
  // one of the user's tracked domains.
  const serpTop = (result.topResults || [])
    .slice(0, 10)
    .map((x) => ({
      position: x.position,
      host: x.host,
      url: x.url || '',
      title: x.title || '',
      own: isOwn(x.host, ownDomains),
    }));

  checks[key] = {
    site: result.site,
    keyword: result.keyword,
    geo: result.geo,
    domain: result.domain,
    gl: result.gl,
    position: result.position,
    top1: result.error ? base.top1 ?? null : top1,
    serpTop: result.error ? base.serpTop || [] : serpTop,
    checkedAt: result.collectedAt,
    error: result.error || null,
    // On an error we didn't get a new reading — keep the last known trend refs.
    prevPosition: result.error ? base.prevPosition : prevPosition,
    yesterdayPosition: result.error ? base.yesterdayPosition : yesterdayPosition,
  };

  if (result.error) {
    await chrome.storage.local.set({ lastChecks: checks });
    return;
  }

  hist.push({ pos: result.position ?? null, at: result.collectedAt });
  if (hist.length > HISTORY_CAP) hist.splice(0, hist.length - HISTORY_CAP);
  histAll[key] = hist;
  await chrome.storage.local.set({ lastChecks: checks, history: histAll });
}

// After a full sweep, send a Telegram digest of EVERY site currently out of
// top-N (with trend vs the previous sweep), so the reminder repeats each run —
// not only on the one sweep where the site first dropped. Governed by the
// `digestEveryRun` setting (default ON).
async function sendSweepDigest(s) {
  if (!s.telegramToken || !s.telegramChatId) return;
  const v = await chrome.storage.local.get(['digestEveryRun', 'lastChecks', 'sweepTargets']);
  if (v.digestEveryRun === false) return;
  const maxPos = s.alertMaxPos ?? 5;

  const sites = siteAggregate(v.lastChecks || {}, v.sweepTargets || [], maxPos);
  const bad = sites.filter((x) => x.status === 'out');
  const inTop = sites.filter((x) => x.status === 'in').length;
  const known = sites.filter((x) => x.status === 'in' || x.status === 'out').length;

  if (known === 0) {
    await sendTelegram(
      s.telegramToken,
      s.telegramChatId,
      `⚠ <b>Rank Peek</b> — прохід завершено, але результатів нема (помилки/блокування).\n🕒 ${fmtNow()}`,
    );
    return;
  }

  if (bad.length === 0) {
    await sendTelegram(
      s.telegramToken,
      s.telegramChatId,
      `✅ <b>Rank Peek</b> — прохід завершено.\nУсі ${inTop} сайтів у топ-${maxPos} (хоча б по одному ключу). Проблемних нема.\n🕒 ${fmtNow()}`,
    );
    return;
  }

  bad.sort((a, b) => (a.bestPos == null ? 1e9 : a.bestPos) - (b.bestPos == null ? 1e9 : b.bestPos) || 0);
  bad.reverse(); // OUT first, then worst

  const lines = bad.map(
    (x) => `• <b>${x.site}</b> · ${x.geo} — поза топ-${maxPos} (найкраща: ${x.bestPos != null ? '#' + x.bestPos : 'OUT'})`,
  );

  const msg =
    `⚠ <b>Rank Peek</b> — сайтів поза топ-${maxPos} (по всіх ключах): <b>${bad.length}</b> (у топі: ${inTop})\n` +
    lines.join('\n') +
    `\n🕒 ${fmtNow()}`;
  await sendTelegramChunked(s.telegramToken, s.telegramChatId, msg);
}

// ---- Scheduling ------------------------------------------------------------

// Minutes from now until the next local HH:00.
function minutesUntilHour(hour) {
  const now = new Date();
  const t = new Date(now);
  t.setHours(hour, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return Math.max(1, Math.round((t - now) / 60_000));
}

async function applySchedule() {
  const v = await chrome.storage.local.get([
    'autoSchedule',
    'scheduleHours',
    'dripMode',
    'dailyReport',
    'dailyReportHour',
    'activeSweep',
    'activeSweepHours',
  ]);
  await chrome.alarms.clear('schedule');
  await chrome.alarms.clear('dailyReport');
  await chrome.alarms.clear('activeSweep');

  if (v.dripMode) {
    // 24/7 continuous drip — make sure a sweep is running (it self-restarts on
    // completion). The legacy every-N-hours alarm is not used in this mode.
    const s = await getSweep();
    if (!s || !s.running) await startSweep();
  } else if (v.autoSchedule) {
    const hours = Math.max(0.5, Number(v.scheduleHours) || 4);
    // First run after `hours`; then every `hours`. Manual "Run" is always available.
    await chrome.alarms.create('schedule', {
      periodInMinutes: hours * 60,
      delayInMinutes: hours * 60,
    });
  }

  if (v.dailyReport) {
    const hour = Math.min(23, Math.max(0, Number(v.dailyReportHour ?? DEFAULT_DAILY_REPORT_HOUR)));
    await chrome.alarms.create('dailyReport', {
      delayInMinutes: minutesUntilHour(hour),
      periodInMinutes: 1440,
    });
  }

  // Separate, usually-faster pass over ONLY the active brands (dropWatch). Runs
  // when the worker is idle between full sweeps. (In 24/7 drip mode a sweep is
  // always running, so this is effectively a no-op — active brands are already
  // covered each cycle.)
  if (v.activeSweep) {
    const ah = Math.max(0.5, Number(v.activeSweepHours) || DEFAULT_ACTIVE_SWEEP_HOURS);
    await chrome.alarms.create('activeSweep', {
      periodInMinutes: ah * 60,
      delayInMinutes: ah * 60,
    });
  }
}

// A once-a-day Telegram summary built from the persisted latest state of EVERY
// target (independent of when individual checks ran). Trend is day-over-day
// (position vs ~24h ago).
async function sendDailyDigest() {
  const cfg = await chrome.storage.local.get([
    'telegramToken',
    'telegramChatId',
    'alertMaxPos',
    'lastChecks',
    'sweepTargets',
  ]);
  if (!cfg.telegramToken || !cfg.telegramChatId) return;
  const maxPos = Number(cfg.alertMaxPos) || 5;
  const checks = Object.values(cfg.lastChecks || {});
  if (!checks.length) return;

  const sites = siteAggregate(cfg.lastChecks || {}, cfg.sweepTargets || [], maxPos);
  const bad = sites.filter((x) => x.status === 'out');
  const inTop = sites.filter((x) => x.status === 'in').length;

  // Freshness: targets not checked in the last ~26h (laptop asleep / CAPTCHA /
  // never reached). Honest note so a stale report isn't mistaken for "all good".
  const staleCut = Date.now() - 26 * 60 * 60 * 1000;
  const stale = checks.filter((c) => {
    const t = c.checkedAt ? new Date(c.checkedAt).getTime() : NaN;
    return Number.isNaN(t) || t < staleCut || c.error;
  }).length;
  const staleLine = stale ? `\n⚠ ${stale} перевірок застарілих (>24 год: сон/блокування).` : '';

  if (bad.length === 0) {
    await sendTelegram(
      cfg.telegramToken,
      cfg.telegramChatId,
      `☀️ <b>Rank Peek</b> — щоденний звіт\nУсі ${inTop} сайтів у топ-${maxPos} (хоча б по одному ключу). Проблемних нема.${staleLine}\n🕒 ${fmtNow()}`,
    );
    return;
  }

  bad.sort((a, b) => (a.bestPos == null ? 1e9 : a.bestPos) - (b.bestPos == null ? 1e9 : b.bestPos));
  bad.reverse();

  const lines = bad.map(
    (x) => `• <b>${x.site}</b> · ${x.geo} — поза топ-${maxPos} по всіх ключах (найкраща: ${x.bestPos != null ? '#' + x.bestPos : 'OUT'})`,
  );

  const msg =
    `☀️ <b>Rank Peek</b> — щоденний звіт\n` +
    `Сайтів поза топ-${maxPos} (по всіх ключах): <b>${bad.length}</b> (у топі: ${inTop})${staleLine}\n` +
    lines.join('\n') +
    `\n🕒 ${fmtNow()}`;
  await sendTelegramChunked(cfg.telegramToken, cfg.telegramChatId, msg);
}

chrome.runtime.onStartup?.addListener(() => {
  applySchedule();
});
chrome.runtime.onInstalled?.addListener(() => {
  applySchedule();
});

// scope='all' → sweep every target (the normal / manual / scheduled run).
// scope='active' → sweep ONLY the active brands (dropWatch list): a one-shot
// scoped burst on its own faster schedule, so those sites are checked more often
// than the full list. Returns false if there's nothing to sweep for the scope.
async function startSweep(scope = 'all') {
  const cfg = await getConfig();
  const c = await chrome.storage.local.get([
    'telegramToken',
    'telegramChatId',
    'alertMaxPos',
    'dropWatch',
  ]);
  let targets = cfg.targets;
  let dripMode = cfg.dripMode;
  if (scope === 'active') {
    const watch = Array.isArray(c.dropWatch) ? c.dropWatch : [];
    const full = watchTargets(watch);
    if (full.length) {
      // The drops watchlist carries its own keyword + geo → sweep those targets
      // directly, independent of the main site list, so EVERY drop-brand is
      // checked (not only the ones that also live in the main list).
      targets = full;
    } else {
      // Legacy domain-only watchlist → check the matching main-list targets.
      const domains = watchDomains(watch);
      targets = (cfg.targets || []).filter((t) => domains.some((d) => matchHost(t.domain, d)));
    }
    if (!targets.length) return false; // nothing active to sweep
    dripMode = false; // scoped active pass is a one-shot burst, never a 24/7 drip
  }
  await setSweep({
    running: true,
    paused: false,
    blocked: false,
    quietPaused: false,
    scope,
    index: 0,
    sinceBreak: 0,
    consecutiveErrors: 0,
    // Randomize order each pass so the query sequence isn't a fixed signature.
    targets: shuffle(targets),
    ingestUrl: cfg.ingestUrl,
    stepDelayMs: cfg.stepDelayMs,
    batchSize: cfg.batchSize,
    batchPauseMs: cfg.batchPauseMs,
    cooldownMs: cfg.cooldownMs,
    dripMode,
    dripGapMs: cfg.dripGapMs,
    quietEnabled: cfg.quietEnabled,
    quietStart: cfg.quietStart,
    quietEnd: cfg.quietEnd,
    alertMaxPos: Number(c.alertMaxPos) || 5,
    telegramToken: c.telegramToken || '',
    telegramChatId: c.telegramChatId || '',
    results: [],
    current: null,
    startedAt: Date.now(),
  });
  await step();
  return true;
}

async function stopSweep() {
  const s = await getSweep();
  if (s) {
    s.running = false;
    s.paused = false;
    s.blocked = false;
    s.current = null;
    await setSweep(s);
  }
  await chrome.alarms.clear('next');
  await chrome.alarms.clear('timeout');
  await chrome.alarms.clear('resume');
}

async function step() {
  const s = await getSweep();
  if (!s || !s.running) return;

  // Night pause: don't fire any query during quiet hours; resume at quietEnd.
  if (s.quietEnabled && inQuietHours(new Date(), s.quietStart, s.quietEnd)) {
    s.quietPaused = true;
    s.current = null;
    await setSweep(s);
    await chrome.alarms.create('next', { when: Date.now() + msUntilQuietEnd(new Date(), s.quietEnd) });
    return;
  }
  if (s.quietPaused) {
    s.quietPaused = false;
    await setSweep(s);
  }

  if (s.index >= s.targets.length) {
    s.running = false;
    s.current = null;
    await setSweep(s);
    const hits = s.results.filter((r) => r.position != null).length;
    if (s.scope !== 'active') {
      try {
        await chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon.png'),
          title: 'Rank Peek — прохід завершено',
          message: `${s.results.length} перевірок, ${hits} у топ-10`,
        });
      } catch {
        /* notifications optional */
      }
    }
    // Scoped active-brand pass: one-shot burst — never self-restart as a drip and
    // skip the full out-of-top digest (drop alerts already fired per query).
    if (s.scope === 'active') return;
    // In 24/7 drip mode keep cycling forever; the daily-report alarm handles
    // the summary, so we skip the per-cycle digest here.
    const drip = (await chrome.storage.local.get('dripMode')).dripMode;
    if (drip) {
      await startSweep();
      return;
    }
    await sendSweepDigest(s); // recurring per-sweep reminder of all out-of-top sites
    return;
  }

  const t = s.targets[s.index];

  // Guard against malformed targets (e.g. stale old-format storage) so we never
  // open an "undefined" search. Record and skip instead of crashing.
  if (!t || !t.keyword || !t.gl || !t.hl) {
    s.results.push({
      site: t?.site ?? '?',
      domain: t?.domain ?? '?',
      keyword: t?.keyword ?? '?',
      geo: t?.geo ?? '?',
      position: null,
      error: 'invalid target — reload extension and re-run',
      checkedOn: today(),
    });
    s.index += 1;
    s.current = null;
    await setSweep(s);
    await chrome.alarms.create('next', { when: Date.now() + 500 });
    return;
  }

  const url =
    `https://www.google.com/search?q=${encodeURIComponent(t.keyword)}` +
    `&gl=${encodeURIComponent(t.gl)}&hl=${encodeURIComponent(t.hl)}&num=10`;
  const tab = await chrome.tabs.create({ url, active: false });
  s.current = { tabId: tab.id, target: t, openedAt: Date.now() };
  await setSweep(s);
  await chrome.alarms.create('timeout', { when: Date.now() + RESULT_TIMEOUT_MS });
}

// Google is challenging us (CAPTCHA / "sorry" / consent). Pause the sweep on the
// current target, surface the challenge tab so the user can solve it once by
// hand, and set a fallback auto-retry in case nobody is at the keyboard.
async function handleBlocked(reason) {
  const s = await getSweep();
  if (!s || !s.running || !s.current || s.blocked) return;

  s.blocked = true;
  s.paused = true;
  s.blockedReason = reason || 'captcha';
  s.blockedAt = Date.now();
  await chrome.alarms.clear('timeout');
  await chrome.alarms.clear('next');
  await setSweep(s);

  // Bring the challenge tab to the front so it can be solved manually.
  try {
    await chrome.tabs.update(s.current.tabId, { active: true });
    const tab = await chrome.tabs.get(s.current.tabId);
    if (tab && tab.windowId != null) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        /* windows API optional */
      }
    }
  } catch {
    /* tab already gone */
  }

  const cooldownMin = Math.round((s.cooldownMs || DEFAULT_COOLDOWN_MIN * 60_000) / 60_000);
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon.png'),
      title: 'Rank Peek — Google показав перевірку',
      message: `Розв'яжи CAPTCHA у відкритій вкладці — прохід продовжиться сам. Авто-повтор через ${cooldownMin} хв.`,
    });
  } catch {
    /* notifications optional */
  }
  if (s.telegramToken && s.telegramChatId) {
    await sendTelegram(
      s.telegramToken,
      s.telegramChatId,
      `⏸ <b>Rank Peek</b> на паузі: Google показав CAPTCHA/перевірку.\n` +
        `Розв'яжи її у браузері — прохід продовжиться сам.\n` +
        `Якщо ні — авто-повтор через ${cooldownMin} хв.`,
    );
  }

  // Fallback: retry the same target after the cooldown even if unattended.
  await chrome.alarms.create('resume', {
    when: Date.now() + (s.cooldownMs || DEFAULT_COOLDOWN_MIN * 60_000),
  });
}

async function recordAndAdvance(result) {
  const s = await getSweep();
  if (!s || !s.running || !s.current) return;

  // A real message from the current tab means we are no longer blocked.
  s.blocked = false;
  s.paused = false;
  await chrome.alarms.clear('resume');
  await chrome.alarms.clear('timeout');

  s.results.push(result);
  s.consecutiveErrors = result.error ? (s.consecutiveErrors || 0) + 1 : 0;

  await updateLastCheck(result, (s.targets || []).map((t) => t.domain)); // persist first
  await maybeAlertSite(s, result); // per-SITE alert (out only if all keywords out)
  await maybeAlertDrops(s, result); // per-QUERY drop alert (active brands only)
  try {
    await fetch(s.ingestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    });
  } catch {
    // Ingest endpoint offline is fine — results are kept in storage and can be
    // exported from the popup. The daily tracker just won't receive them live.
  }
  try {
    await chrome.tabs.remove(s.current.tabId);
  } catch {
    /* tab already gone */
  }
  s.index += 1;
  s.sinceBreak = (s.sinceBreak || 0) + 1;
  s.current = null;

  // Choose the gap before the next query.
  let delayMs;
  if ((s.consecutiveErrors || 0) >= SOFT_FAIL_LIMIT) {
    // Several failures in a row look like a soft/IP block — back off hard.
    delayMs = s.cooldownMs || DEFAULT_COOLDOWN_MIN * 60_000;
    s.consecutiveErrors = 0;
    s.sinceBreak = 0;
    if (s.telegramToken && s.telegramChatId) {
      await sendTelegram(
        s.telegramToken,
        s.telegramChatId,
        `⚠ <b>Rank Peek</b>: схоже на блокування (кілька помилок поспіль).\n` +
          `Пауза ${Math.round(delayMs / 60_000)} хв, потім продовжу автоматично.`,
      );
    }
  } else if (s.dripMode) {
    // Slow drip: a fixed human gap between queries (default ~4 min), jittered,
    // so the pace never bursts. Night pause is enforced in step().
    delayMs = Math.max(DRIP_MIN_GAP_MS, jitter(s.dripGapMs || DEFAULT_DRIP_GAP_MIN * 60_000));
  } else if (s.batchSize && s.sinceBreak >= s.batchSize) {
    // Scheduled long break so a big list is not one uninterrupted burst.
    delayMs = jitter(s.batchPauseMs || DEFAULT_BATCH_PAUSE_SEC * 1000);
    s.sinceBreak = 0;
  } else {
    delayMs = jitter(s.stepDelayMs || DEFAULT_STEP_DELAY_SEC * 1000);
  }

  s.nextAt = Date.now() + delayMs;
  await setSweep(s);
  await chrome.alarms.create('next', { when: s.nextAt });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'rankpeek:serp') {
      const s = await getSweep();
      if (s?.running && s.current && sender.tab?.id === s.current.tabId) {
        const t = s.current.target;
        const found = msg.payload.results.find((r) => matchHost(r.host, t.domain));
        await recordAndAdvance({
          site: t.site,
          domain: t.domain,
          keyword: t.keyword,
          geo: t.geo,
          gl: t.gl,
          position: found ? found.position : null,
          topResults: msg.payload.results.slice(0, 10),
          checkedOn: today(),
          collectedAt: new Date().toISOString(),
        });
      }
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'rankpeek:blocked') {
      // Content script spotted an inline CAPTCHA / "unusual traffic" wall.
      const s = await getSweep();
      if (s?.running && s.current && sender.tab?.id === s.current.tabId) {
        await handleBlocked('captcha');
      }
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'rankpeek:start') {
      await startSweep();
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'rankpeek:startActive') {
      // Manual on-demand run scoped to just the active brands (dropWatch).
      const s = await getSweep();
      if (s?.running) {
        sendResponse?.({ ok: false, reason: 'busy' });
      } else {
        const started = await startSweep('active');
        sendResponse?.({ ok: started, reason: started ? '' : 'empty' });
      }
    } else if (msg?.type === 'rankpeek:stop') {
      await stopSweep();
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'rankpeek:schedule') {
      await applySchedule();
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'rankpeek:testTg') {
      const c = await chrome.storage.local.get(['telegramToken', 'telegramChatId']);
      const r = await telegramTest(c.telegramToken, c.telegramChatId);
      sendResponse?.(r);
    }
  })();
  return true; // keep the message channel open for the async response
});

// Watch the current sweep tab for a redirect to a challenge page. `tabs`
// permission gives us the URL even for hosts we did not inject into.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url || '';
  if (!isBlockUrl(url)) return;
  const s = await getSweep();
  if (s?.running && s.current && s.current.tabId === tabId && !s.blocked) {
    await handleBlocked(/consent/i.test(url) ? 'consent' : 'captcha');
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'schedule') {
    const s = await getSweep();
    if (!s || !s.running) await startSweep(); // scheduled run (skip if one is active)
  } else if (alarm.name === 'activeSweep') {
    // Faster scoped pass over just the active brands — only when idle, so it
    // never collides with (or interrupts) a full sweep.
    const s = await getSweep();
    if (!s || !s.running) await startSweep('active');
  } else if (alarm.name === 'dailyReport') {
    await sendDailyDigest();
  } else if (alarm.name === 'next') {
    await step();
  } else if (alarm.name === 'resume') {
    // Cooldown after a block elapsed and nobody solved it — retry the same
    // target on a fresh tab.
    const s = await getSweep();
    if (s?.running && s.paused) {
      if (s.current?.tabId != null) {
        try {
          await chrome.tabs.remove(s.current.tabId);
        } catch {
          /* tab already gone */
        }
      }
      s.paused = false;
      s.blocked = false;
      s.current = null;
      await setSweep(s);
      await step();
    }
  } else if (alarm.name === 'timeout') {
    const s = await getSweep();
    if (s?.running && !s.paused && s.current) {
      const t = s.current.target;
      await recordAndAdvance({
        site: t.site,
        domain: t.domain,
        keyword: t.keyword,
        geo: t.geo,
        gl: t.gl,
        position: null,
        topResults: [],
        error: 'timeout (no results — CAPTCHA/consent/blocked?)',
        checkedOn: today(),
        collectedAt: new Date().toISOString(),
      });
    }
  }
});
