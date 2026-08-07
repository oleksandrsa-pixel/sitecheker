// Rank Peek — drops page.
//
// For each tracked query shows the FULL top-10 SERP and highlights the "drops":
// repurposed / expired domains we push into Google to grab a position. They give
// themselves away because they look nothing like the rest of a casino SERP —
// random legit-business names (barber shop, sushi, pediatrics, dance studio…)
// on any TLD (.com/.org/.it/.es/.pt/.fr/.gr).
//
// A result is flagged as a drop when its domain is NOT one of your own tracked
// sites, NOT a mainstream aggregator, and contains NO gambling word — i.e. it is
// the odd one out. Domains you list yourself (your known drops) are marked as
// confirmed. Every row keeps its full, copyable URL.

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
// carries one of these in its domain (your brands + real competitors + review
// portals). A domain with NONE of them, that isn't yours and isn't a mainstream
// site, is the tell-tale "drop". Tuned toward this niche's vocabulary — extend
// freely.
//
// Unambiguous stems below are matched as plain substrings (rare inside normal
// words: catches casino/casinò/kasyno, slot, gambling, poker, roulette…).
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

// Normalise anything the user pastes into the drop-list to a registrable host.
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

function parseDropList(text) {
  const out = [];
  const seen = new Set();
  for (const piece of String(text || '').split(/[\s,;]+/)) {
    const h = parseHost(piece);
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

const inDropList = (host, drops) => (drops || []).some((d) => hostMatches(host, d));

let DROPS = []; // user's confirmed drop domains (from the list below)

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
  dropknown: { cls: 'k-drop', label: 'ДРОП' },
  drop: { cls: 'k-dropq', label: 'ДРОП?' },
  noise: { cls: 'k-noise', label: 'агрегатор' },
  comp: { cls: 'k-comp', label: 'конкурент' },
};
const isDropKind = (kind) => kind === 'drop' || kind === 'dropknown';

// Classify a single SERP row. Priority: your own target → your other tracked
// site → a domain you listed as a known drop → mainstream aggregator → a normal
// gambling result (competitor) → otherwise the odd-one-out heuristic drop.
function classify(x, c, drops) {
  if (hostMatches(x.host, c.domain)) return 'you';
  if (x.own) return 'own';
  if (inDropList(x.host, drops)) return 'dropknown';
  if (isNoise(x.host)) return 'noise';
  if (isGambling(x.host)) return 'comp';
  return 'drop';
}

// Build the classified SERP list for a target from its stored top-10 (falls back
// to the old competitors field for checks recorded before v0.8).
function buildSerp(c, drops = DROPS) {
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
    kind: classify(x, c, drops),
  }));
}

const dropCount = (serp) => serp.filter((x) => isDropKind(x.kind)).length;

let ROWS = [];

function load() {
  chrome.storage.local.get(['lastChecks', 'dropDomains'], (v) => {
    DROPS = Array.isArray(v.dropDomains) ? v.dropDomains : [];
    if ($('droplist')) $('droplist').value = DROPS.join('\n');
    ROWS = Object.values(v.lastChecks || {})
      .map((c) => {
        const serp = buildSerp(c, DROPS);
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
  const geos = [...new Set(ROWS.map((r) => r.geo).filter(Boolean))].sort();
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
  $('sub').textContent =
    `${rows.length} з ${ROWS.length} запитів · знайдено дропів у топ-10: ${totalDrops}` +
    (DROPS.length ? ` · у списку підтверджених: ${DROPS.length}` : '');
  if (!ROWS.length) {
    $('list').innerHTML = '<div class="empty">Нема даних. Зроби прохід у розширенні (▶ Прохід), тоді онови цю сторінку.</div>';
    return;
  }
  if (!rows.length) {
    $('list').innerHTML = '<div class="empty">Нічого не знайдено за фільтром.</div>';
    return;
  }
  $('list').innerHTML = rows
    .map((r) => {
      const body = r.serp.length
        ? r.serp.map(serpRow).join('')
        : `<div class="none">${r.error ? 'Перевірка з помилкою (' + esc(r.error) + ')' : 'Видачі не зчитано'}</div>`;
      const dropBadge = r.drops
        ? `<span class="dropcount">🎯 дропів: ${r.drops}</span>`
        : '';
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

// ---- Confirmed drop-list (your own pushed domains) -------------------------

function saveDropList() {
  const drops = parseDropList($('droplist').value);
  chrome.storage.local.set({ dropDomains: drops }, () => {
    DROPS = drops;
    $('droplist').value = drops.join('\n');
    $('dropmsg').style.color = '#34d399';
    $('dropmsg').textContent = `Збережено ✓ ${drops.length} домен(ів)`;
    load();
    setTimeout(() => ($('dropmsg').textContent = ''), 2500);
  });
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
  ROWS.forEach((r) => {
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
$('refresh').addEventListener('click', load);
if ($('savedrops')) $('savedrops').addEventListener('click', saveDropList);

load();
