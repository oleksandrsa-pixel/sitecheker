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

const $ = (id) => document.getElementById(id);

function validTargets(list) {
  return (
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((t) => t && typeof t === 'object' && t.domain && t.keyword && t.gl && t.hl)
  );
}

function loadConfig() {
  chrome.storage.local.get(
    [
      'sweepTargets',
      'ingestUrl',
      'stepDelaySec',
      'batchSize',
      'batchPauseSec',
      'cooldownMin',
      'telegramToken',
      'telegramChatId',
      'alertMaxPos',
      'digestEveryRun',
      'dropAlerts',
      'autoSchedule',
      'scheduleHours',
      'dripMode',
      'dripGapMin',
      'quietEnabled',
      'quietStart',
      'quietEnd',
      'dailyReport',
      'dailyReportHour',
    ],
    (v) => {
      const targets = validTargets(v.sweepTargets) ? v.sweepTargets : DEFAULT_TARGETS;
      $('targets').value = JSON.stringify(targets, null, 2);
      $('ingest').value = v.ingestUrl || 'http://127.0.0.1:33000/ingest/serp';
      $('delay').value = v.stepDelaySec || 20;
      $('batch').value = v.batchSize != null ? v.batchSize : 20;
      $('batchpause').value = v.batchPauseSec || 180;
      $('cooldown').value = v.cooldownMin || 30;
      $('tgtoken').value = v.telegramToken || '';
      $('tgchat').value = v.telegramChatId || '';
      $('maxpos').value = v.alertMaxPos || 5;
      $('digest').checked = v.digestEveryRun !== false; // default ON
      $('dropalerts').checked = v.dropAlerts !== false; // default ON
      $('auto').checked = Boolean(v.autoSchedule);
      $('hours').value = v.scheduleHours || 4;
      $('drip').checked = Boolean(v.dripMode);
      $('dripgap').value = v.dripGapMin || 4;
      $('quiet').checked = v.quietEnabled !== false; // default ON
      $('quietstart').value = v.quietStart != null ? v.quietStart : 23;
      $('quietend').value = v.quietEnd != null ? v.quietEnd : 7;
      $('daily').checked = Boolean(v.dailyReport);
      $('dailyhour').value = v.dailyReportHour != null ? v.dailyReportHour : 9;
    },
  );
}

$('save').addEventListener('click', () => {
  let targets;
  try {
    targets = JSON.parse($('targets').value);
    if (!Array.isArray(targets)) throw new Error('не масив');
  } catch (e) {
    $('msg').style.color = '#dc2626';
    $('msg').textContent = 'Помилка JSON: ' + e.message;
    return;
  }
  // sweepTargets = objects for the auto-sweep; targets = domain strings for the
  // passive overlay highlighting (keep both in sync from one editor).
  const overlayDomains = [...new Set(targets.map((t) => t.domain).filter(Boolean))];
  const stepDelaySec = Math.max(3, Number($('delay').value) || 20);
  const batchSize = Math.max(0, Number($('batch').value) || 0);
  const batchPauseSec = Math.max(30, Number($('batchpause').value) || 180);
  const cooldownMin = Math.max(1, Number($('cooldown').value) || 30);
  chrome.storage.local.set(
    {
      sweepTargets: targets,
      targets: overlayDomains,
      ingestUrl: $('ingest').value.trim(),
      stepDelaySec,
      batchSize,
      batchPauseSec,
      cooldownMin,
    },
    () => {
      $('msg').style.color = '#16a34a';
      $('msg').textContent = `Збережено ✓ (${targets.length} цілей)`;
      setTimeout(() => ($('msg').textContent = ''), 2000);
    },
  );
});

$('run').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'rankpeek:start' }));
$('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'rankpeek:stop' }));
$('report').addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('report.html') }),
);
$('reporty').addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('report.html?day=yesterday') }),
);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}`;
}

function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows) {
  const p = (n) => String(n).padStart(2, '0');
  const header = ['Сайт', 'Кейворд', 'Гео', 'Позиція', 'Дата', 'Час', 'Домен', 'Хто #1', 'Помилка'];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    const iso = r.collectedAt || r.checkedAt || '';
    const d = iso ? new Date(iso) : null;
    const valid = d && !Number.isNaN(d.getTime());
    const date =
      r.checkedOn || (valid ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` : '');
    const time = valid ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : '';
    const pos = r.position != null ? r.position : r.error ? 'ERR' : 'OUT';
    const top1 = (r.topResults && r.topResults[0] && r.topResults[0].host) || '';
    lines.push(
      [r.site, r.keyword, r.geo, pos, date, time, r.domain, top1, r.error || '']
        .map(csvEscape)
        .join(','),
    );
  }
  // BOM (UTF-8/Cyrillic) + `sep=,` hint so Excel splits into columns on open
  // regardless of the machine's list-separator locale.
  return `﻿sep=,\r\n${lines.join('\r\n')}`;
}

function getExportRows(cb) {
  chrome.storage.local.get(['sweep', 'lastChecks'], (v) => {
    let rows = v.sweep?.results ?? [];
    if (!rows.length && v.lastChecks) rows = Object.values(v.lastChecks);
    cb(rows);
  });
}

$('csv').addEventListener('click', () => {
  getExportRows((rows) => {
    if (!rows.length) return;
    download(`rank-peek-${stamp()}.csv`, buildCsv(rows), 'text/csv;charset=utf-8');
  });
});

$('export').addEventListener('click', () => {
  getExportRows((rows) => {
    if (!rows.length) return;
    download(`rank-peek-${stamp()}.json`, JSON.stringify(rows, null, 2), 'application/json');
  });
});

// Drops now live in their own structured page (drops.html): the full top-10
// SERP with your pushed / repurposed drop-domains highlighted.
$('drops').addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('drops.html') }),
);

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function posPill(position, error) {
  if (error) return '<span class="pill p-bad">err</span>';
  if (position == null) return '<span class="pill p-bad">OUT</span>';
  const cls = position <= 3 ? 'p-good' : position <= 5 ? 'p-mid' : 'p-bad';
  return `<span class="pill ${cls}">#${position}</span>`;
}

function render() {
  chrome.storage.local.get(
    ['sweep', 'sweepTargets', 'lastChecks', 'autoSchedule', 'scheduleHours'],
    (v) => {
      const s = v.sweep;
      const targets = validTargets(v.sweepTargets) ? v.sweepTargets : DEFAULT_TARGETS;
      const checks = v.lastChecks || {};

      // Status badge — reset any inline colour first so a prior paused (red)
      // state never leaks into the next render.
      const badge = $('badge');
      badge.style.background = '';
      badge.style.color = '';
      if (s?.running && s.quietPaused) {
        badge.textContent = '🌙 нічна пауза';
        badge.className = 'badge';
        badge.style.background = 'rgba(99,102,241,.18)';
        badge.style.color = '#a5b4fc';
      } else if (s?.running && s.paused) {
        badge.textContent = s.blocked ? '⏸ CAPTCHA — реши у вкладці' : '⏸ пауза';
        badge.className = 'badge';
        badge.style.background = 'rgba(248,113,113,.16)';
        badge.style.color = '#f87171';
      } else if (s?.running) {
        badge.textContent = `прохід ${s.results?.length ?? 0}/${s.targets?.length ?? targets.length}`;
        badge.className = 'badge run';
      } else if (v.autoSchedule) {
        badge.textContent = `авто · кожні ${v.scheduleHours || 4} год`;
        badge.className = 'badge auto';
      } else {
        badge.textContent = 'вручну';
        badge.className = 'badge';
      }

      // Status line
      if (s?.running && s.quietPaused) {
        $('status').textContent = 'Нічна пауза — перевірки відновляться вранці.';
      } else if (s?.running && s.paused) {
        const cur = s.current?.target;
        $('status').textContent = s.blocked
          ? `Google показав перевірку${cur ? ` на «${cur.keyword}»` : ''}. Розв'яжи CAPTCHA у відкритій вкладці — прохід продовжиться сам.`
          : 'Пауза — зачекай, прохід відновиться автоматично.';
      } else if (s?.running) {
        const cur = s.current?.target;
        $('status').textContent =
          `Іде прохід… ${s.results?.length ?? 0}/${s.targets?.length ?? 0}` +
          (cur ? ` — зараз «${cur.keyword}» (${cur.geo})` : '');
      } else if (s && s.results?.length) {
        const hits = s.results.filter((r) => r.position != null && r.position <= 5).length;
        $('status').textContent = `Останній прохід: ${s.results.length} перевірок · у топ-5: ${hits}`;
      } else {
        $('status').textContent = `${targets.length} цілей · натисни «Прохід»`;
      }

      // One row per configured target, joined with its last check.
      const tbody = $('results').querySelector('tbody');
      tbody.innerHTML = targets
        .map((t) => {
          const lc = checks[`${t.domain}|${t.keyword}|${t.gl}`];
          return (
            '<tr>' +
            `<td class="site">${t.site}</td>` +
            `<td class="kw">${t.keyword}</td>` +
            `<td class="geo">${t.geo || t.gl}</td>` +
            `<td>${lc ? posPill(lc.position, lc.error) : '<span class="when">—</span>'}</td>` +
            `<td class="when">${lc ? fmtTime(lc.checkedAt) : '—'}</td>` +
            '</tr>'
          );
        })
        .join('');
    },
  );
}

$('savetg').addEventListener('click', () => {
  const cfg = {
    telegramToken: $('tgtoken').value.trim(),
    telegramChatId: $('tgchat').value.trim(),
    alertMaxPos: Math.max(1, Number($('maxpos').value) || 5),
    digestEveryRun: $('digest').checked,
    dropAlerts: $('dropalerts').checked,
    autoSchedule: $('auto').checked,
    scheduleHours: Math.max(1, Number($('hours').value) || 4),
    dripMode: $('drip').checked,
    dripGapMin: Math.min(60, Math.max(1, Number($('dripgap').value) || 4)),
    quietEnabled: $('quiet').checked,
    quietStart: Math.min(23, Math.max(0, Number($('quietstart').value) || 0)),
    quietEnd: Math.min(23, Math.max(0, Number($('quietend').value) || 0)),
    dailyReport: $('daily').checked,
    dailyReportHour: Math.min(23, Math.max(0, Number($('dailyhour').value) || 9)),
  };
  chrome.storage.local.set(cfg, () => {
    chrome.runtime.sendMessage({ type: 'rankpeek:schedule' }); // (re)arm alarms / start drip
    $('tgmsg').style.color = '#16a34a';
    const parts = [];
    if (cfg.dripMode) parts.push(`drip ~${cfg.dripGapMin} хв`);
    else if (cfg.autoSchedule) parts.push(`авто-прохід кожні ${cfg.scheduleHours} год`);
    else parts.push('авто-прохід вимкнено');
    if (cfg.quietEnabled) parts.push(`нічна пауза ${cfg.quietStart}-${cfg.quietEnd}`);
    if (cfg.dailyReport) parts.push(`звіт о ${cfg.dailyReportHour}:00`);
    $('tgmsg').textContent = `Збережено ✓ · ${parts.join(' · ')}`;
    setTimeout(() => ($('tgmsg').textContent = ''), 3000);
  });
});

$('testtg').addEventListener('click', () => {
  chrome.storage.local.set(
    {
      telegramToken: $('tgtoken').value.trim(),
      telegramChatId: $('tgchat').value.trim(),
    },
    () => {
      $('tgmsg').style.color = '#555';
      $('tgmsg').textContent = 'Надсилаю…';
      chrome.runtime.sendMessage({ type: 'rankpeek:testTg' }, (resp) => {
        $('tgmsg').style.color = resp?.ok ? '#16a34a' : '#dc2626';
        $('tgmsg').textContent = resp?.ok
          ? 'Надіслано ✓ — перевір Telegram'
          : 'Помилка: перевір token / chat_id';
      });
    },
  );
});

// ---- CSV import ------------------------------------------------------------

// Country name -> Google gl (country) + hl (local UI language). Extend freely.
const GEO_MAP = {
  italy: { gl: 'it', hl: 'it' },
  greece: { gl: 'gr', hl: 'el' },
  portugal: { gl: 'pt', hl: 'pt' },
  france: { gl: 'fr', hl: 'fr' },
  spain: { gl: 'es', hl: 'es' },
  germany: { gl: 'de', hl: 'de' },
  brazil: { gl: 'br', hl: 'pt-BR' },
  'united kingdom': { gl: 'uk', hl: 'en' },
  uk: { gl: 'uk', hl: 'en' },
  poland: { gl: 'pl', hl: 'pl' },
  netherlands: { gl: 'nl', hl: 'nl' },
  austria: { gl: 'at', hl: 'de' },
  switzerland: { gl: 'ch', hl: 'de' },
  belgium: { gl: 'be', hl: 'fr' },
  ireland: { gl: 'ie', hl: 'en' },
  canada: { gl: 'ca', hl: 'en' },
  romania: { gl: 'ro', hl: 'ro' },
  hungary: { gl: 'hu', hl: 'hu' },
  czechia: { gl: 'cz', hl: 'cs' },
  'czech republic': { gl: 'cz', hl: 'cs' },
  sweden: { gl: 'se', hl: 'sv' },
  norway: { gl: 'no', hl: 'no' },
  finland: { gl: 'fi', hl: 'fi' },
  denmark: { gl: 'dk', hl: 'da' },
  turkey: { gl: 'tr', hl: 'tr' },
  mexico: { gl: 'mx', hl: 'es' },
  chile: { gl: 'cl', hl: 'es' },
  argentina: { gl: 'ar', hl: 'es' },
  japan: { gl: 'jp', hl: 'ja' },
  india: { gl: 'in', hl: 'en' },
};

function splitCsvLine(line, delim = ',') {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Figure out the delimiter: honour an Excel `sep=;` hint line, else guess from
// the header (comma / semicolon / tab — European Excel often saves with ';').
// Returns { delim, headerLine, dataLines }.
function detectDelimiter(lines) {
  let rows = lines.slice();
  rows[0] = rows[0].replace(/^﻿/, ''); // strip BOM
  let delim = ',';
  const m = /^sep=(.)\s*$/i.exec(rows[0]);
  if (m) {
    delim = m[1];
    rows = rows.slice(1);
    rows[0] = (rows[0] || '').replace(/^﻿/, '');
  } else {
    const h = rows[0] || '';
    const counts = {
      ',': (h.match(/,/g) || []).length,
      ';': (h.match(/;/g) || []).length,
      '\t': (h.match(/\t/g) || []).length,
    };
    delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    if (!counts[delim]) delim = ',';
  }
  return { delim, rows };
}

function hostFromUrl(value) {
  const raw = (value || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

function titleCase(s) {
  const t = (s || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function geoToGlHl(geo, langColumn) {
  const key = (geo || '').trim().toLowerCase();
  if (GEO_MAP[key]) return GEO_MAP[key];
  const lang = (langColumn || '').trim().toLowerCase();
  // Accept a bare 2-letter country code (e.g. "es", "it") as gl.
  if (/^[a-z]{2}$/.test(key)) return { gl: key, hl: lang || key };
  return { gl: lang || 'us', hl: lang || 'en' }; // best-effort fallback
}

// Minimal required columns: Domain + keyword (+ a GEO or language_code so we
// know which Google to query). Everything else is optional. Header names are
// matched case-insensitively and accept common aliases, so a hand-made file
// like `Domain,keyword,second keyword,GEO` just works. Duplicate
// (domain × keyword × gl) rows are collapsed automatically.
function parseCsvToTargets(text) {
  const rawLines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (rawLines.length < 2) throw new Error('порожній файл');

  const { delim, rows: lines } = detectDelimiter(rawLines);
  if (lines.length < 2) throw new Error('порожній файл');

  const headers = splitCsvLine(lines[0], delim).map((h) => h.trim().toLowerCase());
  const idx = (aliases) => {
    for (const a of aliases) {
      const i = headers.indexOf(a);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iGeo = idx(['geo', 'country', 'location', 'location_name']);
  const iBrand = idx(['brand', 'name', 'brand name', 'brand_name']);
  const iDomain = idx(['domain', 'url', 'website', 'link', 'site_url', 'site url']);
  const iKw = idx(['keyword', 'key', 'kw', 'keyword1', 'main keyword', 'main_keyword']);
  const iKw2 = idx([
    'second keyword', 'second_keyword', 'keyword2', 'kw2', 'second key', 'additional keyword', 'extra keyword',
  ]);
  const iLang = idx(['language_code', 'lang', 'language', 'hl']);
  const iActive = idx(['is_active', 'active', 'enabled']);

  if (iDomain < 0 || iKw < 0) {
    throw new Error('потрібні щонайменше колонки Domain і keyword');
  }
  if (iGeo < 0 && iLang < 0) {
    throw new Error('додай колонку GEO (країна) або language_code');
  }

  const targets = [];
  const seen = new Set();
  let duplicates = 0;
  for (let r = 1; r < lines.length; r += 1) {
    const c = splitCsvLine(lines[r], delim);
    const activeRaw = iActive < 0 ? 'true' : (c[iActive] || '').trim();
    if (!/^(true|1|yes|y|on)$/i.test(activeRaw)) continue;

    const domain = hostFromUrl(c[iDomain]);
    const mainKw = (c[iKw] || '').trim();
    const geo = (iGeo >= 0 ? c[iGeo] || '' : '').trim();
    const { gl, hl } = geoToGlHl(geo, iLang >= 0 ? c[iLang] : '');
    // Brand is just a display label — default to the keyword (or domain).
    const brand = iBrand >= 0 ? (c[iBrand] || '').trim() : '';
    const site = brand || titleCase(mainKw) || domain;

    const keywords = [mainKw];
    if (iKw2 >= 0 && (c[iKw2] || '').trim()) keywords.push((c[iKw2] || '').trim());

    for (const keyword of keywords) {
      if (!domain || !keyword || !gl || !hl) continue;
      const dedupeKey = `${domain}|${keyword.toLowerCase()}|${gl}`;
      if (seen.has(dedupeKey)) {
        duplicates += 1;
        continue;
      }
      seen.add(dedupeKey);
      targets.push({ site, domain, keyword, gl, hl, geo: geo || gl.toUpperCase() });
    }
  }

  if (targets.length === 0) throw new Error('не знайдено активних рядків');
  targets.duplicatesRemoved = duplicates; // annotation for the import message
  return targets;
}

$('csvfile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const targets = parseCsvToTargets(String(reader.result));
      const overlayDomains = [...new Set(targets.map((t) => t.domain))];
      chrome.storage.local.set({ sweepTargets: targets, targets: overlayDomains }, () => {
        $('targets').value = JSON.stringify(targets, null, 2);
        $('csvmsg').style.color = '#16a34a';
        const dup = targets.duplicatesRemoved
          ? ` (−${targets.duplicatesRemoved} дублів)`
          : '';
        $('csvmsg').textContent = `Завантажено ✓ ${overlayDomains.length} сайтів, ${targets.length} цілей${dup}`;
      });
    } catch (err) {
      $('csvmsg').style.color = '#dc2626';
      $('csvmsg').textContent = `Помилка CSV: ${err.message}`;
    }
  };
  reader.readAsText(file, 'utf-8');
});

loadConfig();
render();
setInterval(render, 700);
