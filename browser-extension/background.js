// Rank Peek — background sweep orchestrator (MV3 service worker).
//
// Drives the tracked-target list through Google ONE query at a time, at a
// human pace, in background tabs that use the USER'S own session/login/geo,
// reads each SERP via the content script, and POSTs each result to the tracker
// ingest endpoint. Alarms are used so the sweep survives service-worker
// suspension between steps.

const DEFAULT_INGEST = 'http://127.0.0.1:33000/ingest/serp';
const DEFAULT_STEP_DELAY_SEC = 15; // human pace between queries (configurable in popup)
const RESULT_TIMEOUT_MS = 20_000; // abandon a query with no result after this

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
  const v = await chrome.storage.local.get(['sweepTargets', 'ingestUrl', 'stepDelaySec']);
  const delaySec = Math.max(3, Number(v.stepDelaySec) || DEFAULT_STEP_DELAY_SEC);
  return {
    targets: validTargets(v.sweepTargets) ? v.sweepTargets : DEFAULT_TARGETS,
    ingestUrl: v.ingestUrl || DEFAULT_INGEST,
    stepDelayMs: delaySec * 1000,
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

// Persist the last check (position + timestamp) per target so the popup can
// show "last run" for each site even between sweeps.
async function updateLastCheck(result) {
  const key = `${result.domain}|${result.keyword}|${result.gl}`;
  const store = (await chrome.storage.local.get('lastChecks')).lastChecks || {};
  store[key] = {
    site: result.site,
    keyword: result.keyword,
    geo: result.geo,
    domain: result.domain,
    gl: result.gl,
    position: result.position,
    checkedAt: result.collectedAt,
    error: result.error || null,
  };
  await chrome.storage.local.set({ lastChecks: store });
}

// ---- Scheduling ------------------------------------------------------------

async function applySchedule() {
  const v = await chrome.storage.local.get(['autoSchedule', 'scheduleHours']);
  await chrome.alarms.clear('schedule');
  if (v.autoSchedule) {
    const hours = Math.max(0.5, Number(v.scheduleHours) || 4);
    // First run after `hours`; then every `hours`. Manual "Run" is always available.
    await chrome.alarms.create('schedule', {
      periodInMinutes: hours * 60,
      delayInMinutes: hours * 60,
    });
  }
}

chrome.runtime.onStartup?.addListener(() => {
  applySchedule();
});
chrome.runtime.onInstalled?.addListener(() => {
  applySchedule();
});

async function startSweep() {
  const { targets, ingestUrl, stepDelayMs } = await getConfig();
  const cfg = await chrome.storage.local.get([
    'telegramToken',
    'telegramChatId',
    'alertMaxPos',
  ]);
  await setSweep({
    running: true,
    index: 0,
    targets,
    ingestUrl,
    stepDelayMs,
    alertMaxPos: Number(cfg.alertMaxPos) || 5,
    telegramToken: cfg.telegramToken || '',
    telegramChatId: cfg.telegramChatId || '',
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
    s.current = null;
    await setSweep(s);
  }
  await chrome.alarms.clearAll();
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
        iconUrl: 'icon.png',
        title: 'Rank Peek — прохід завершено',
        message: `${s.results.length} перевірок, ${hits} у топ-10`,
      });
    } catch {
      /* notifications optional */
    }
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

async function recordAndAdvance(result) {
  const s = await getSweep();
  if (!s || !s.running || !s.current) return;

  s.results.push(result);
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
  await chrome.alarms.clear('timeout');
  s.index += 1;
  s.current = null;
  await setSweep(s);
  await chrome.alarms.create('next', {
    when: Date.now() + (s.stepDelayMs || DEFAULT_STEP_DELAY_SEC * 1000),
  });
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'schedule') {
    const s = await getSweep();
    if (!s || !s.running) await startSweep(); // scheduled 4h run (skip if one is active)
  } else if (alarm.name === 'next') {
    await step();
  } else if (alarm.name === 'timeout') {
    const s = await getSweep();
    if (s?.running && s.current) {
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
