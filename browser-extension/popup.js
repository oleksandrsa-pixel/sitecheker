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
      'autoSchedule',
      'scheduleHours',
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
      $('auto').checked = Boolean(v.autoSchedule);
      $('hours').value = v.scheduleHours || 4;
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
  return `﻿${lines.join('\r\n')}`; // BOM so Excel opens UTF-8/Cyrillic correctly
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

// ---- Competitors export ----------------------------------------------------

// Aggregators / platforms that are not direct competitors — excluded from the list.
const NOISE = [
  'wikipedia.org',
  'trustpilot.com',
  'google.com',
  'apps.apple.com',
  'youtube.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'reddit.com',
  'tiktok.com',
  'linkedin.com',
  'pinterest.com',
  'tripadvisor.com',
];
const hostMatches = (host, base) => {
  const h = (host || '').replace(/^www\./, '').toLowerCase();
  const b = base.replace(/^www\./, '').toLowerCase();
  return h === b || h.endsWith('.' + b);
};
const isNoise = (host) => NOISE.some((n) => hostMatches(host, n));

function buildCompetitorsCsv(results, ownDomains, topN) {
  const isOwn = (host) => ownDomains.some((d) => hostMatches(host, d));
  const p = (n) => String(n).padStart(2, '0');
  const header = [
    'Мій сайт',
    'Мій кейворд',
    'Гео',
    'Моя поз.',
    'Дата/час',
    '№',
    'Позиція в SERP',
    'Домен конкурента',
    'Заголовок',
    'URL',
  ];
  const lines = [header.map(csvEscape).join(',')];

  // Main keyword per site = FIRST result for each domain (targets are stored
  // main-keyword-first), so we take one SERP per site.
  const seen = new Set();
  for (const r of results) {
    if (seen.has(r.domain)) continue;
    seen.add(r.domain);

    const iso = r.collectedAt || '';
    const d = iso ? new Date(iso) : null;
    const when =
      d && !Number.isNaN(d.getTime())
        ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
            d.getMinutes(),
          )}`
        : r.checkedOn || '';
    const myPos = r.position != null ? r.position : r.error ? 'ERR' : 'OUT';

    const comps = (r.topResults || [])
      .filter((x) => !isOwn(x.host) && !isNoise(x.host))
      .slice(0, topN);

    if (!comps.length) {
      lines.push(
        [r.site, r.keyword, r.geo, myPos, when, '', '', '(конкурентів не знайдено)', '', '']
          .map(csvEscape)
          .join(','),
      );
      continue;
    }
    comps.forEach((c, i) => {
      lines.push(
        [r.site, r.keyword, r.geo, myPos, when, i + 1, c.position, c.host, c.title || '', c.url || '']
          .map(csvEscape)
          .join(','),
      );
    });
  }
  return `﻿${lines.join('\r\n')}`;
}

$('comp').addEventListener('click', () => {
  chrome.storage.local.get(['sweep', 'sweepTargets'], (v) => {
    const results = v.sweep?.results ?? [];
    if (!results.length) {
      $('status').textContent = 'Спершу зроби прохід — тоді буде що вивантажити.';
      return;
    }
    const ownDomains = (validTargets(v.sweepTargets) ? v.sweepTargets : DEFAULT_TARGETS).map(
      (t) => t.domain,
    );
    download(
      `rank-peek-competitors-${stamp()}.csv`,
      buildCompetitorsCsv(results, ownDomains, 5),
      'text/csv;charset=utf-8',
    );
  });
});

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

      // Status badge
      const badge = $('badge');
      if (s?.running && s.paused) {
        badge.textContent = s.blocked ? '⏸ CAPTCHA — реши у вкладці' : '⏸ пауза';
        badge.className = 'badge';
        badge.style.background = 'rgba(248,113,113,.16)';
        badge.style.color = '#f87171';
      } else if (s?.running) {
        badge.style.background = '';
        badge.style.color = '';
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
      if (s?.running && s.paused) {
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
    autoSchedule: $('auto').checked,
    scheduleHours: Math.max(1, Number($('hours').value) || 4),
  };
  chrome.storage.local.set(cfg, () => {
    chrome.runtime.sendMessage({ type: 'rankpeek:schedule' }); // (re)arm or clear the 4h alarm
    $('tgmsg').style.color = '#16a34a';
    $('tgmsg').textContent = cfg.autoSchedule
      ? `Збережено ✓ · авто-прохід кожні ${cfg.scheduleHours} год`
      : 'Збережено ✓ · авто-прохід вимкнено';
    setTimeout(() => ($('tgmsg').textContent = ''), 2500);
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

function splitCsvLine(line) {
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
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
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

function geoToGlHl(geo, langColumn) {
  const key = (geo || '').trim().toLowerCase();
  if (GEO_MAP[key]) return GEO_MAP[key];
  const lang = (langColumn || '').trim().toLowerCase();
  return { gl: lang || 'us', hl: lang || 'en' }; // best-effort fallback
}

function parseCsvToTargets(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('порожній файл');

  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name) => headers.indexOf(name);
  const iGeo = col('geo');
  const iBrand = col('brand');
  const iDomain = col('domain');
  const iKw = col('keyword');
  const iKw2 = col('second keyword');
  const iLoc = col('location_name');
  const iLang = col('language_code');
  const iActive = col('is_active');

  if (iBrand < 0 || iDomain < 0 || iKw < 0) {
    throw new Error('потрібні колонки Brand, Domain, keyword');
  }

  const targets = [];
  for (let r = 1; r < lines.length; r += 1) {
    const c = splitCsvLine(lines[r]);
    const activeRaw = iActive < 0 ? 'true' : (c[iActive] || '').trim();
    if (!/^(true|1|yes|y|on)$/i.test(activeRaw)) continue;

    const site = (c[iBrand] || '').trim();
    const domain = hostFromUrl(c[iDomain]);
    const geo = ((iGeo >= 0 ? c[iGeo] : '') || (iLoc >= 0 ? c[iLoc] : '') || '').trim();
    const { gl, hl } = geoToGlHl(geo, iLang >= 0 ? c[iLang] : '');

    const keywords = [(c[iKw] || '').trim()];
    if (iKw2 >= 0 && (c[iKw2] || '').trim()) keywords.push((c[iKw2] || '').trim());

    for (const keyword of keywords) {
      if (site && domain && keyword && gl && hl) {
        targets.push({ site, domain, keyword, gl, hl, geo: geo || gl.toUpperCase() });
      }
    }
  }

  if (targets.length === 0) throw new Error('не знайдено активних рядків');
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
        $('csvmsg').textContent = `Завантажено ✓ ${overlayDomains.length} сайтів, ${targets.length} цілей`;
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
