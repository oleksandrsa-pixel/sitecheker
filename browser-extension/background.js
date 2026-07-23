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
const DEFAULT_DRIP_WINDOW_H = 20; // 24/7 mode: spread the whole list over this many hours
const DRIP_MIN_GAP_MS = 60_000; // never faster than 1/min even for tiny lists
const DEFAULT_DAILY_REPORT_HOUR = 9; // daily Telegram report time (local)

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
const today = () => new Date().toISOString().slice(0, 10);

// Random jitter so gaps between queries never look mechanical (±35%).
const jitter = (ms) => Math.round(ms * (0.65 + Math.random() * 0.7));

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
    'dripWindowHours',
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
    dripWindowMs: Math.max(1, Number(v.dripWindowHours) || DEFAULT_DRIP_WINDOW_H) * 3600_000,
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

// Decide whether a result crossed the alert threshold vs the previous sweep and,
// if so, push a per-site Telegram message. Persists last position per target.
async function maybeAlert(s, result) {
  // Ignore technical failures (CAPTCHA/consent/timeout) — not a real drop.
  if (result.error) return;

  const maxPos = s.alertMaxPos ?? 5;
  const key = `${result.domain}|${result.keyword}|${result.gl}`;
  const store = (await chrome.storage.local.get('lastPositions')).lastPositions || {};
  const prev = key in store ? store[key] : undefined; // number | null | undefined
  const cur = result.position; // number | null

  const isBad = cur == null || cur > maxPos;
  const wasBad = prev === null || (typeof prev === 'number' && prev > maxPos);

  let msg = null;
  if (isBad && !wasBad) {
    const reason = cur == null ? `❌ ЗНИК із видачі` : `⬇ Випав із топ-${maxPos}`;
    const prevTxt = prev === undefined ? '—' : prev == null ? 'поза видачею' : `#${prev}`;
    const curTxt = cur == null ? 'немає у видачі' : `#${cur}`;
    msg =
      `🔴 <b>${result.site}</b> · ${result.geo} · «${result.keyword}»\n` +
      `${reason}\n` +
      `Позиція: ${prevTxt} → ${curTxt}\n` +
      `🕒 ${result.collectedAt}\n` +
      `https://${result.domain}`;
  } else if (!isBad && wasBad) {
    msg =
      `🟢 <b>${result.site}</b> · ${result.geo} · «${result.keyword}»\n` +
      `Повернувся в топ-${maxPos}: #${cur}\n🕒 ${result.collectedAt}`;
  }

  store[key] = cur;
  await chrome.storage.local.set({ lastPositions: store });

  if (msg) await sendTelegram(s.telegramToken, s.telegramChatId, msg);
}

// One day in ms — the window used for the "yesterday" comparison.
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_CAP = 60; // keep the last N readings per target

// Persist the last check (position + timestamp) per target so the popup and the
// report page can show "last run" for each site even between sweeps. Also keep a
// rolling per-target history so the report can show previous / yesterday /
// trend, and store those derived values on the check for convenience.
async function updateLastCheck(result) {
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

  checks[key] = {
    site: result.site,
    keyword: result.keyword,
    geo: result.geo,
    domain: result.domain,
    gl: result.gl,
    position: result.position,
    top1: result.error ? base.top1 ?? null : top1,
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
  const v = await chrome.storage.local.get(['digestEveryRun', 'lastChecks']);
  if (v.digestEveryRun === false) return;
  const checks = v.lastChecks || {};
  const maxPos = s.alertMaxPos ?? 5;

  const ok = s.results.filter((r) => !r.error);
  const bad = ok.filter((r) => r.position == null || r.position > maxPos);
  const inTop = ok.length - bad.length;

  if (ok.length === 0) {
    await sendTelegram(
      s.telegramToken,
      s.telegramChatId,
      `⚠ <b>Rank Peek</b> — прохід завершено, але результатів нема ` +
        `(${s.results.length} помилок/блокувань).\n🕒 ${fmtNow()}`,
    );
    return;
  }

  if (bad.length === 0) {
    await sendTelegram(
      s.telegramToken,
      s.telegramChatId,
      `✅ <b>Rank Peek</b> — прохід завершено.\n` +
        `Усі ${inTop} цілей у топ-${maxPos}. Проблемних нема.\n🕒 ${fmtNow()}`,
    );
    return;
  }

  bad.sort((a, b) => {
    const pa = a.position == null ? 1e9 : a.position;
    const pb = b.position == null ? 1e9 : b.position;
    return pb - pa; // OUT first, then worst rank first
  });

  const lines = bad.map((r) => {
    const lc = checks[`${r.domain}|${r.keyword}|${r.gl}`] || {};
    const curTxt = r.position == null ? 'OUT' : `#${r.position}`;
    return `• <b>${r.site}</b> · ${r.geo} · «${r.keyword}» — ${curTxt} ${trendText(lc.prevPosition, r.position)}`;
  });

  const msg =
    `⚠ <b>Rank Peek</b> — поза топ-${maxPos}: <b>${bad.length}</b> (у топі: ${inTop})\n` +
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
  ]);
  await chrome.alarms.clear('schedule');
  await chrome.alarms.clear('dailyReport');

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
  ]);
  if (!cfg.telegramToken || !cfg.telegramChatId) return;
  const maxPos = Number(cfg.alertMaxPos) || 5;
  const checks = Object.values(cfg.lastChecks || {});
  if (!checks.length) return;

  const ok = checks.filter((c) => !c.error);
  const bad = ok.filter((c) => c.position == null || c.position > maxPos);
  const inTop = ok.length - bad.length;

  if (bad.length === 0) {
    await sendTelegram(
      cfg.telegramToken,
      cfg.telegramChatId,
      `☀️ <b>Rank Peek</b> — щоденний звіт\nУсі ${inTop} цілей у топ-${maxPos}. Проблемних нема.\n🕒 ${fmtNow()}`,
    );
    return;
  }

  bad.sort((a, b) => {
    const pa = a.position == null ? 1e9 : a.position;
    const pb = b.position == null ? 1e9 : b.position;
    return pb - pa;
  });

  const lines = bad.map((c) => {
    const base = c.yesterdayPosition !== undefined ? c.yesterdayPosition : c.prevPosition;
    const curTxt = c.position == null ? 'OUT' : `#${c.position}`;
    return `• <b>${c.site}</b> · ${c.geo} · «${c.keyword}» — ${curTxt} ${trendText(base, c.position)}`;
  });

  const msg =
    `☀️ <b>Rank Peek</b> — щоденний звіт\n` +
    `Поза топ-${maxPos}: <b>${bad.length}</b> (у топі: ${inTop})\n` +
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

async function startSweep() {
  const cfg = await getConfig();
  const c = await chrome.storage.local.get([
    'telegramToken',
    'telegramChatId',
    'alertMaxPos',
  ]);
  await setSweep({
    running: true,
    paused: false,
    blocked: false,
    index: 0,
    sinceBreak: 0,
    consecutiveErrors: 0,
    targets: cfg.targets,
    ingestUrl: cfg.ingestUrl,
    stepDelayMs: cfg.stepDelayMs,
    batchSize: cfg.batchSize,
    batchPauseMs: cfg.batchPauseMs,
    cooldownMs: cfg.cooldownMs,
    dripMode: cfg.dripMode,
    dripWindowMs: cfg.dripWindowMs,
    alertMaxPos: Number(c.alertMaxPos) || 5,
    telegramToken: c.telegramToken || '',
    telegramChatId: c.telegramChatId || '',
    results: [],
    current: null,
    startedAt: Date.now(),
  });
  await step();
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

  if (s.index >= s.targets.length) {
    s.running = false;
    s.current = null;
    await setSweep(s);
    const hits = s.results.filter((r) => r.position != null).length;
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

  await maybeAlert(s, result); // immediate per-site Telegram alert on drop / recovery
  await updateLastCheck(result); // persist last position + timestamp per site
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
    // 24/7 drip: spread the whole list evenly across the window, heavily
    // randomized, so the pace looks human and never bursts.
    const per = (s.dripWindowMs || DEFAULT_DRIP_WINDOW_H * 3600_000) / Math.max(1, s.targets.length);
    delayMs = Math.max(DRIP_MIN_GAP_MS, jitter(per));
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
    } else if (msg?.type === 'rankpeek:stop') {
      await stopSweep();
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'rankpeek:schedule') {
      await applySchedule();
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'rankpeek:testTg') {
      const c = await chrome.storage.local.get(['telegramToken', 'telegramChatId']);
      const ok = await sendTelegram(
        c.telegramToken,
        c.telegramChatId,
        '✅ Rank Peek підключено. Сюди приходитимуть алерти про падіння сайтів із топ-5.',
      );
      sendResponse?.({ ok });
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
