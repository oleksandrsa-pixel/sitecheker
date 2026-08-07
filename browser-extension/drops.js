// Rank Peek — drops page.
//
// Watches ONLY the brands you're actively launching drops for (a small list you
// load here), pulls their top-10 SERP from the regular sweep, and AUTO-flags the
// "drops": repurposed / expired domains that look nothing like a casino SERP —
// random legit-business names (barber shop, sushi, pediatrics, dance studio…)
// on any TLD (.com/.org/.it/.es/.pt/.fr/.gr). No manual drop entry: a result is
// flagged a drop when it isn't your own tracked site, isn't a mainstream
// aggregator, and carries NO gambling word. Every row keeps its copyable URL.

const $ = (id) => document.getElementById(id);

// Mainstream platforms / authority sites — never a "drop", even though their
// names carry no gambling word.
const NOISE = [
  'wikipedia.org', 'trustpilot.com', 'google.com', 'apps.apple.com', 'youtube.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'reddit.com', 'tiktok.com',
  'linkedin.com', 'pinterest.com', 'tripadvisor.com', 'yelp.com', 'quora.com',
  'medium.com', 'github.com', 'apple.com', 'play.google.com', 'maps.google.com',
];

// Gambling / betting word-stems. A normal casino SERP result almost always
// carries one of these; a domain with NONE — that isn't yours and isn't a
// mainstream site — is the tell-tale "drop".
//
// Unambiguous stems are matched as plain substrings (rare inside normal words:
// casino/casinò/kasyno, slot, gambling, poker, roulette…).
const GAMBLING = [
  'casino', 'casin', 'kasino', 'kazino', 'cazino', 'kasyno', 'slot', 'gambl',
  'poker', 'roulette', 'ruleta', 'roleta', 'jackpot', 'vegas', 'bonus',
  'scommesse', 'apuest', 'aposta', 'bookmaker', 'betting', 'wager', 'spela',
];
// Short, VERY common stems match ONLY when isolated by a non-letter (digit /
// dash / dot / start / end). So casino brands like x3bet, 22bet, 20bet are
// caught, but ordinary business names that merely contain the fragment
// (baldwin, sherbet, winter, potluck, mistake, betterhomes) are NOT — those
// stay flagged as drops. A false "gambling" hit here would MISS a drop, the
// worst error for this tab, so we deliberately bias toward catching odd domains.
const GAMBLING_BOUNDED = /(^|[^a-z])(bet|win|spin|luck|stake)([^a-z]|$)/;

const hostMatches = (host, base) => {
  const h = (host || '').replace(/^www\./, '').toLowerCase();
  const b = (base || '').replace(/^www\./, '').toLowerCase();
  return !!h && !!b && (h === b || h.endsWith('.' + b));
};
const isNoise = (host) => NOISE.some((n) => hostMatches(host, n));

function isGambling(host) {
  const h = (host || '').replace(/^www\./, '').toLowerCase();
  if (!h) return false;
  return GAMBLING.some((t) => h.includes(t)) || GAMBLING_BOUNDED.test(h);
}

// ---- Active-brand watchlist (the only thing you maintain) -------------------

let WATCH = []; // registrable domains of brands you're currently launching

const inWatch = (domain) => WATCH.some((d) => hostMatches(domain, d));

function parseHost(value) {
  const raw = (value || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

function detectDelim(line) {
  const c = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of line || '') if (ch in c) c[ch] += 1;
  const best = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
  return c[best] ? best : ',';
}

function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Pull brand domains out of a pasted list OR a CSV. Robust to the main
// site-list format: on each line we take the first cell that parses to a real
// host (contains a dot), skipping header words and any `sep=` hint.
function parseWatchInput(text) {
  const out = [];
  const seen = new Set();
  const HEADER = /^(domain|url|website|site|site_url|link|keyword|second keyword|geo|country|brand|name|location|language_code|lang|is_active)$/i;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, '').trim();
    if (!line || /^sep=/i.test(line)) continue;
    const delim = /[,;\t]/.test(line) ? detectDelim(line) : '\n';
    const cells = delim === '\n' ? [line] : splitCsvLine(line, delim);
    for (const cell of cells) {
      const c = cell.trim();
      if (!c || HEADER.test(c)) continue;
      const h = parseHost(c);
      if (h && h.includes('.')) {
        if (!seen.has(h)) { seen.add(h); out.push(h); }
        break; // one domain per line
      }
    }
  }
  return out;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function myPill(c) {
  if (c.error) return `<span class="pill p-bad" title="${esc(c.error)}">err</span>`;
  if (c.position == null) return '<span class="pill p-bad">OUT</span>';
  const cls = c.position <= 3 ? 'p-good' : c.position <= 5 ? 'p-mid' : 'p-bad';
  return `<span class="pill ${cls}">#${c.position}</span>`;
}

const KIND = {
  you: { cls: 'k-you', label: 'ВАШ САЙТ' },
  own: { cls: 'k-own', label: 'ваш сайт' },
  drop: { cls: 'k-drop', label: 'ДРОП' },
  noise: { cls: 'k-noise', label: 'агрегатор' },
  comp: { cls: 'k-comp', label: 'конкурент' },
};
const isDropKind = (kind) => kind === 'drop';

// Classify a SERP row. Priority: your own target → your other tracked site →
// mainstream aggregator → a normal gambling result (competitor) → otherwise the
// odd-one-out heuristic drop.
function classify(x, c) {
  if (hostMatches(x.host, c.domain)) return 'you';
  if (x.own) return 'own';
  if (isNoise(x.host)) return 'noise';
  if (isGambling(x.host)) return 'comp';
  return 'drop';
}

function buildSerp(c) {
  const list =
    Array.isArray(c.serpTop) && c.serpTop.length
      ? c.serpTop
      : Array.isArray(c.competitors)
        ? c.competitors.map((x) => ({ ...x, own: false }))
        : [];
  return list.map((x) => ({
    position: x.position,
    host: x.host,
    url: x.url || '',
    title: x.title || '',
    kind: classify(x, c),
  }));
}

const dropCount = (serp) => serp.filter((x) => isDropKind(x.kind)).length;

let ROWS = [];

// Config (watchlist) — read once on open and after a save; kept separate from
// the data reload so auto-refresh never clobbers the textarea while you type.
function loadWatch(cb) {
  chrome.storage.local.get(['dropWatch'], (v) => {
    WATCH = Array.isArray(v.dropWatch) ? v.dropWatch : [];
    if ($('watchlist')) $('watchlist').value = WATCH.join('\n');
    if (cb) cb();
  });
}

function loadData() {
  chrome.storage.local.get(['lastChecks'], (v) => {
    ROWS = Object.values(v.lastChecks || {})
      .map((c) => {
        const serp = buildSerp(c);
        return {
          site: c.site || c.domain,
          keyword: c.keyword,
          geo: c.geo || (c.gl ? c.gl.toUpperCase() : ''),
          gl: c.gl,
          domain: c.domain,
          position: c.position,
          error: c.error || null,
          checkedAt: c.checkedAt || '',
          serp,
          drops: dropCount(serp),
        };
      })
      .sort((a, b) =>
        (b.drops - a.drops) || // queries with drops float to the top
        (a.site || '').localeCompare(b.site || '') ||
        (a.geo || '').localeCompare(b.geo || '') ||
        (a.keyword || '').localeCompare(b.keyword || ''),
      );
    populateGeo();
    render();
  });
}

function populateGeo() {
  const prev = $('geo').value; // keep the user's selection across reloads / refresh
  const pool = WATCH.length ? ROWS.filter((r) => inWatch(r.domain)) : ROWS;
  const geos = [...new Set(pool.map((r) => r.geo).filter(Boolean))].sort();
  $('geo').innerHTML =
    '<option value="">Усі гео</option>' +
    geos.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  if (prev && geos.includes(prev)) $('geo').value = prev;
}

function view() {
  const q = $('q').value.trim().toLowerCase();
  const geo = $('geo').value;
  const onlydrops = $('onlydrops').checked;
  return ROWS.filter((r) => {
    if (WATCH.length && !inWatch(r.domain)) return false; // scope to active brands
    if (geo && r.geo !== geo) return false;
    if (onlydrops && r.drops === 0) return false;
    if (!q) return true;
    const hay = [r.site, r.keyword, r.geo, ...r.serp.map((x) => x.host + ' ' + x.url)]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

function serpRow(x) {
  const k = KIND[x.kind] || KIND.comp;
  const copyBtn = x.url
    ? `<button class="copy" data-url="${esc(x.url)}" title="Скопіювати посилання">⧉ копіювати</button>`
    : '';
  return (
    `<div class="srow ${k.cls}">` +
    `<span class="rk">#${x.position}</span>` +
    `<span class="tag ${k.cls}">${k.label}</span>` +
    `<div class="meta">` +
    `<div class="host">${esc(x.host)}${x.title ? ` — <span class="ttl">${esc(x.title)}</span>` : ''}</div>` +
    `<div class="urlline">${x.url ? `<a class="url" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a>` : '<span class="url">—</span>'}${copyBtn}</div>` +
    `</div>` +
    `</div>`
  );
}

function render() {
  const rows = view();
  const totalDrops = rows.reduce((n, r) => n + r.drops, 0);
  const brands = new Set(rows.map((r) => (r.domain || '').replace(/^www\./, '').toLowerCase())).size;
  $('sub').textContent = WATCH.length
    ? `${WATCH.length} активних брендів · ${rows.length} запитів · знайдено дропів у топ-10: ${totalDrops}`
    : `усі сайти: ${rows.length} запитів · дропів: ${totalDrops} · ⬆ завантаж CSV активних брендів, щоб бачити лише їх`;

  if (!ROWS.length) {
    $('list').innerHTML = '<div class="empty">Нема даних. Зроби прохід у розширенні (▶ Прохід), тоді онови цю сторінку.</div>';
    return;
  }
  if (!rows.length) {
    $('list').innerHTML = WATCH.length
      ? `<div class="empty">Жоден з ${WATCH.length} активних брендів ще не має даних з прогону.<br />Переконайся, що ці домени є у списку сайтів (розділ CSV), і зроби ▶ Прохід — дані з'являться тут.</div>`
      : '<div class="empty">Нічого не знайдено за фільтром.</div>';
    return;
  }
  $('list').innerHTML = rows
    .map((r) => {
      const body = r.serp.length
        ? r.serp.map(serpRow).join('')
        : `<div class="none">${r.error ? 'Перевірка з помилкою (' + esc(r.error) + ')' : 'Видачі не зчитано'}</div>`;
      const dropBadge = r.drops
        ? `<span class="dropcount">🎯 дропів: ${r.drops}</span>`
        : '<span class="dropcount zero">без дропів</span>';
      return (
        '<div class="card">' +
        '<div class="head">' +
        `<span class="brand">${esc(r.site)}</span>` +
        `<span class="kw">«${esc(r.keyword)}»</span>` +
        `<span class="geo">${esc(r.geo)}</span>` +
        dropBadge +
        `<span class="me"><span class="lbl">моя позиція:</span> ${myPill(r)}` +
        (r.checkedAt ? ` <span class="badge">${fmtTime(r.checkedAt)}</span>` : '') +
        '</span>' +
        '</div>' +
        `<div class="serp">${body}</div>` +
        '</div>'
      );
    })
    .join('');
}

// Copy-to-clipboard (event delegation over the whole list)
$('list').addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.copy');
  if (!btn) return;
  const url = btn.getAttribute('data-url') || '';
  const done = () => {
    const old = btn.textContent;
    btn.textContent = '✓ скопійовано';
    btn.classList.add('ok');
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove('ok');
    }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => fallbackCopy(url, done));
  } else {
    fallbackCopy(url, done);
  }
});

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    /* ignore */
  }
  ta.remove();
}

// ---- Save / import the active-brand watchlist ------------------------------

function applyWatch(list) {
  chrome.storage.local.set({ dropWatch: list }, () => {
    WATCH = list;
    if ($('watchlist')) $('watchlist').value = list.join('\n');
    if ($('watchmsg')) {
      $('watchmsg').style.color = '#34d399';
      $('watchmsg').textContent = list.length
        ? `Збережено ✓ ${list.length} активних брендів`
        : 'Список очищено — показую всі сайти';
      setTimeout(() => ($('watchmsg').textContent = ''), 2500);
    }
    loadData();
  });
}

function saveWatch() {
  applyWatch(parseWatchInput($('watchlist').value));
}

// ---- CSV export (full SERP, Excel-friendly) --------------------------------

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function buildCsv() {
  const header = ['Мій сайт', 'Кейворд', 'Гео', 'Моя поз.', 'Дата/час', 'Позиція', 'Тип', 'Дроп?', 'Домен', 'Заголовок', 'URL'];
  const lines = [header.map(csvEscape).join(',')];
  view().forEach((r) => {
    const my = r.error ? 'ERR' : r.position == null ? 'OUT' : r.position;
    if (!r.serp.length) {
      lines.push([r.site, r.keyword, r.geo, my, fmtTime(r.checkedAt), '', '', '', '', '(видачі не зчитано)', ''].map(csvEscape).join(','));
      return;
    }
    r.serp.forEach((x) => {
      const type = (KIND[x.kind] || KIND.comp).label;
      const drop = isDropKind(x.kind) ? 'так' : '';
      lines.push([r.site, r.keyword, r.geo, my, fmtTime(r.checkedAt), x.position, type, drop, x.host, x.title, x.url].map(csvEscape).join(','));
    });
  });
  return `﻿sep=,\r\n${lines.join('\r\n')}`;
}

$('csv').addEventListener('click', () => {
  if (!ROWS.length) return;
  const url = URL.createObjectURL(new Blob([buildCsv()], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `rank-peek-drops-${stamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

$('q').addEventListener('input', render);
$('geo').addEventListener('change', render);
$('onlydrops').addEventListener('change', render);
$('refresh').addEventListener('click', loadData);
if ($('savewatch')) $('savewatch').addEventListener('click', saveWatch);
if ($('watchcsv')) {
  $('watchcsv').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const list = parseWatchInput(String(reader.result));
      if ($('watchmsg') && !list.length) {
        $('watchmsg').style.color = '#f87171';
        $('watchmsg').textContent = 'У файлі не знайдено доменів';
        return;
      }
      applyWatch(list);
    };
    reader.readAsText(file, 'utf-8');
  });
}

// Near-real-time: re-pull the latest sweep data every 60s so an open tab stays
// current between (and during) runs. Only the data + render refresh — the
// watchlist textarea is left alone so it never clobbers what you're typing.
if (typeof setInterval === 'function') setInterval(loadData, 60000);

loadWatch(loadData);
