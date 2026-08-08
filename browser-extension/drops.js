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

// The tell-tale marker drops put in their SERP <title> — e.g.
// "Vipsta Sitio Oficial ᐉ Vipsta Acceso". This ᐉ (U+1409) is the PRECISE drop
// signal: a top-10 result whose title carries it is a drop, so ads / reviews /
// random competitor sites are no longer mistaken for drops. Extendable list —
// add a glyph here if you spot drops using a different one.
const DROP_MARKERS = ['ᐉ']; // ᐉ CANADIAN SYLLABICS PWO
function hasMarker(title) {
  const t = String(title || '');
  return DROP_MARKERS.some((m) => t.includes(m));
}

// ---- Active-brand watchlist (the only thing you maintain) -------------------
//
// The watchlist is a FULL target list in the same shape as the main site CSV:
// Domain, keyword, second keyword, GEO. Parsed into targets so the active-brand
// sweep can check EVERY drop-brand directly (with its own keyword + geo), not
// only the ones that happen to be in the main site list. Legacy domain strings
// (older saves) still work as a plain view/alert filter.

let WATCH = []; // target objects {site,domain,keyword,gl,hl,geo} (or legacy domain strings)
let WATCH_DOMAINS = []; // unique registrable domains of the watched brands

const norm = (d) => String(d || '').replace(/^www\./, '').toLowerCase();
function watchDomains(list) {
  const out = [];
  const seen = new Set();
  for (const x of list || []) {
    const d = norm(typeof x === 'string' ? x : x && x.domain);
    if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}
// Full, sweepable targets (have a keyword + gl/hl) vs bare domain entries.
const watchTargets = (list) =>
  (list || []).filter((x) => x && typeof x === 'object' && x.domain && x.keyword && x.gl && x.hl);
const inWatch = (domain) => WATCH_DOMAINS.some((d) => hostMatches(domain, d));

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

// Country -> Google gl (country) + hl (language). Keep roughly in sync with the
// GEO_MAP in popup.js.
const GEO_MAP = {
  italy: { gl: 'it', hl: 'it' }, greece: { gl: 'gr', hl: 'el' }, portugal: { gl: 'pt', hl: 'pt' },
  france: { gl: 'fr', hl: 'fr' }, spain: { gl: 'es', hl: 'es' }, germany: { gl: 'de', hl: 'de' },
  brazil: { gl: 'br', hl: 'pt-BR' }, 'united kingdom': { gl: 'uk', hl: 'en' }, uk: { gl: 'uk', hl: 'en' },
  poland: { gl: 'pl', hl: 'pl' }, netherlands: { gl: 'nl', hl: 'nl' }, austria: { gl: 'at', hl: 'de' },
  switzerland: { gl: 'ch', hl: 'de' }, belgium: { gl: 'be', hl: 'fr' }, ireland: { gl: 'ie', hl: 'en' },
  canada: { gl: 'ca', hl: 'en' }, romania: { gl: 'ro', hl: 'ro' }, hungary: { gl: 'hu', hl: 'hu' },
  czechia: { gl: 'cz', hl: 'cs' }, 'czech republic': { gl: 'cz', hl: 'cs' }, sweden: { gl: 'se', hl: 'sv' },
  norway: { gl: 'no', hl: 'no' }, finland: { gl: 'fi', hl: 'fi' }, denmark: { gl: 'dk', hl: 'da' },
  turkey: { gl: 'tr', hl: 'tr' }, mexico: { gl: 'mx', hl: 'es' }, chile: { gl: 'cl', hl: 'es' },
  argentina: { gl: 'ar', hl: 'es' }, japan: { gl: 'jp', hl: 'ja' }, india: { gl: 'in', hl: 'en' },
};
function geoToGlHl(geo, lang) {
  const key = String(geo || '').trim().toLowerCase();
  if (GEO_MAP[key]) return GEO_MAP[key];
  const l = String(lang || '').trim().toLowerCase();
  if (/^[a-z]{2}$/.test(key)) return { gl: key, hl: l || key };
  return { gl: l || 'us', hl: l || 'en' };
}
function titleCase(s) {
  const t = (s || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

const HEADER_WORD = /^(domain|url|website|site|site_url|link|keyword|second keyword|geo|country|brand|name|location|location_name|language_code|lang|is_active)$/i;
function bareTarget(cell) {
  const c = String(cell || '').trim();
  if (!c || HEADER_WORD.test(c)) return null;
  const d = parseHost(c);
  return d && d.includes('.') ? { site: d, domain: d } : null;
}
function dedupeTargets(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const key = `${norm(t.domain)}|${(t.keyword || '').toLowerCase()}|${t.gl || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// Parse the drops watchlist. Accepts the full site-CSV format
// (Domain, keyword, second keyword, GEO — headers/aliases, sep= hint, ; or ,
// delimiter, is_active) AND a plain one-domain-per-line list. Rows with a
// keyword+geo become full sweepable targets; bare domains become domain-only
// entries used just to filter the view / alerts.
function parseWatchTargets(text) {
  let lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  lines[0] = lines[0].replace(/^﻿/, '');
  if (/^sep=(.)\s*$/i.test(lines[0])) {
    lines = lines.slice(1);
    if (lines.length) lines[0] = lines[0].replace(/^﻿/, '');
  }
  if (!lines.length) return [];

  const first = lines[0] || '';
  const delim = /[,;\t]/.test(first) ? detectDelim(first) : null;
  if (!delim) return dedupeTargets(lines.map((l) => bareTarget(l)).filter(Boolean));

  const header = splitCsvLine(lines[0], delim).map((h) => h.trim().toLowerCase());
  const idx = (aliases) => {
    for (const a of aliases) { const i = header.indexOf(a); if (i >= 0) return i; }
    return -1;
  };
  const iDomain = idx(['domain', 'url', 'website', 'site', 'link', 'site_url', 'site url']);
  const iKw = idx(['keyword', 'key', 'kw', 'keyword1', 'main keyword', 'main_keyword']);
  const iKw2 = idx(['second keyword', 'second_keyword', 'keyword2', 'kw2', 'second key', 'additional keyword', 'extra keyword']);
  const iGeo = idx(['geo', 'country', 'location', 'location_name']);
  const iLang = idx(['language_code', 'lang', 'language', 'hl']);
  const iBrand = idx(['brand', 'name', 'brand name', 'brand_name']);
  const iActive = idx(['is_active', 'active', 'enabled']);
  const hasHeader = iDomain >= 0 || iKw >= 0 || iGeo >= 0 || iBrand >= 0;
  if (!hasHeader) {
    return dedupeTargets(lines.map((l) => bareTarget(splitCsvLine(l, delim)[0])).filter(Boolean));
  }

  const domainCol = iDomain >= 0 ? iDomain : 0;
  const out = [];
  for (let r = 1; r < lines.length; r += 1) {
    const c = splitCsvLine(lines[r], delim);
    if (iActive >= 0 && !/^(true|1|yes|y|on)$/i.test((c[iActive] || '').trim())) continue;
    const domain = parseHost(c[domainCol] || '');
    if (!domain || !domain.includes('.')) continue;
    const geo = iGeo >= 0 ? (c[iGeo] || '').trim() : '';
    const { gl, hl } = geoToGlHl(geo, iLang >= 0 ? c[iLang] : '');
    const mainKw = iKw >= 0 ? (c[iKw] || '').trim() : '';
    const brand = iBrand >= 0 ? (c[iBrand] || '').trim() : '';
    const site = brand || titleCase(mainKw) || domain;
    const geoLabel = geo || (gl ? gl.toUpperCase() : '');
    const kws = [];
    if (mainKw) kws.push(mainKw);
    if (iKw2 >= 0 && (c[iKw2] || '').trim()) kws.push((c[iKw2] || '').trim());
    if (!kws.length) { out.push({ site, domain, geo: geoLabel }); continue; }
    for (const keyword of kws) out.push({ site, domain, keyword, gl, hl, geo: geoLabel });
  }
  return dedupeTargets(out);
}

// Reconstruct editable text for the textarea from a stored watchlist (used only
// when no raw text was saved — e.g. legacy domain-string saves).
function watchToText(list) {
  if (!list || !list.length) return '';
  if (list.every((x) => typeof x === 'string')) return list.join('\n');
  const lines = ['Domain,keyword,GEO'];
  const seen = new Set();
  for (const t of list) {
    const d = typeof t === 'string' ? t : t.domain;
    const kw = typeof t === 'string' ? '' : t.keyword || '';
    const geo = typeof t === 'string' ? '' : t.geo || '';
    const key = `${d}|${kw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push([d, kw, geo].join(','));
  }
  return lines.join('\n');
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
  comp: { cls: 'k-comp', label: 'конкурент' },
  noise: { cls: 'k-noise', label: 'агрегатор' },
  other: { cls: 'k-other', label: 'інше' },
};
const isDropKind = (kind) => kind === 'drop';

// Classify a SERP row. Priority: your own target → your other tracked site →
// a DROP (title carries the ᐉ marker) → mainstream aggregator → a gambling
// result (competitor casino) → otherwise just another site (ad / review / etc.).
function classify(x, c) {
  if (hostMatches(x.host, c.domain)) return 'you';
  if (x.own) return 'own';
  if (hasMarker(x.title)) return 'drop'; // ᐉ marker — the precise drop signal
  if (isNoise(x.host)) return 'noise';
  if (isGambling(x.host)) return 'comp';
  return 'other';
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
  chrome.storage.local.get(['dropWatch', 'dropWatchText'], (v) => {
    WATCH = Array.isArray(v.dropWatch) ? v.dropWatch : [];
    WATCH_DOMAINS = watchDomains(WATCH);
    if ($('watchlist')) $('watchlist').value = v.dropWatchText != null ? v.dropWatchText : watchToText(WATCH);
    if (cb) cb();
  });
}

function loadData() {
  chrome.storage.local.get(['lastChecks'], (v) => {
    ROWS = Object.values(v.lastChecks || {}).map((c) => {
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
    });

    // Show every active-brand query, even the ones not swept yet, as "pending" —
    // so you immediately see all watched brands (not only those already checked).
    const checked = new Set(ROWS.map((r) => `${norm(r.domain)}|${(r.keyword || '').toLowerCase()}|${r.gl || ''}`));
    for (const t of watchTargets(WATCH)) {
      const key = `${norm(t.domain)}|${(t.keyword || '').toLowerCase()}|${t.gl || ''}`;
      if (checked.has(key)) continue;
      ROWS.push({
        site: t.site || t.domain,
        keyword: t.keyword,
        geo: t.geo || (t.gl ? t.gl.toUpperCase() : ''),
        gl: t.gl,
        domain: t.domain,
        position: undefined,
        error: null,
        checkedAt: '',
        serp: [],
        drops: 0,
        pending: true,
      });
    }

    ROWS.sort((a, b) =>
      (a.pending === b.pending ? 0 : a.pending ? 1 : -1) || // checked first, pending last
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
  const pool = WATCH_DOMAINS.length ? ROWS.filter((r) => inWatch(r.domain)) : ROWS;
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
    if (WATCH_DOMAINS.length && !inWatch(r.domain)) return false; // scope to active brands
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
  const pendingCount = rows.filter((r) => r.pending).length;
  const pendTxt = pendingCount ? ` · ще не перевірено: ${pendingCount}` : '';
  $('sub').textContent = WATCH_DOMAINS.length
    ? `${WATCH_DOMAINS.length} активних брендів · ${rows.length} запитів · знайдено дропів у топ-10: ${totalDrops}${pendTxt}`
    : `усі сайти: ${rows.length} запитів · дропів: ${totalDrops} · ⬆ завантаж CSV активних брендів, щоб бачити лише їх`;

  if (!rows.length) {
    $('list').innerHTML = WATCH_DOMAINS.length
      ? '<div class="empty">Список активних брендів збережено, але даних ще нема. Натисни <b>🎯 Прогін дропів</b> у popup — і результати зʼявляться тут.</div>'
      : (ROWS.length
        ? '<div class="empty">Нічого не знайдено за фільтром.</div>'
        : '<div class="empty">Нема даних. Зроби прохід у розширенні (▶ Прохід), тоді онови цю сторінку.</div>');
    return;
  }
  $('list').innerHTML = rows
    .map((r) => {
      const body = r.pending
        ? '<div class="none">⏳ ще не перевірено — натисни «🎯 Прогін дропів» у popup</div>'
        : r.serp.length
          ? r.serp.map(serpRow).join('')
          : `<div class="none">${r.error ? 'Перевірка з помилкою (' + esc(r.error) + ')' : 'Видачі не зчитано'}</div>`;
      const dropBadge = r.pending
        ? '<span class="dropcount zero">⏳ ще не перевірено</span>'
        : r.drops
          ? `<span class="dropcount">🎯 дропів: ${r.drops}</span>`
          : '<span class="dropcount zero">без дропів</span>';
      const posCell = r.pending ? '<span class="pill p-mid">⏳</span>' : myPill(r);
      return (
        `<div class="card${r.pending ? ' pending' : ''}">` +
        '<div class="head">' +
        `<span class="brand">${esc(r.site)}</span>` +
        `<span class="kw">«${esc(r.keyword)}»</span>` +
        `<span class="geo">${esc(r.geo)}</span>` +
        dropBadge +
        `<span class="me"><span class="lbl">моя позиція:</span> ${posCell}` +
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

function applyWatch(targets, text) {
  chrome.storage.local.set({ dropWatch: targets, dropWatchText: text }, () => {
    WATCH = targets;
    WATCH_DOMAINS = watchDomains(targets);
    if ($('watchlist')) $('watchlist').value = text;
    if ($('watchmsg')) {
      const brands = WATCH_DOMAINS.length;
      const queries = watchTargets(targets).length;
      $('watchmsg').style.color = brands ? '#34d399' : '#9aa0bd';
      $('watchmsg').textContent = brands
        ? `Збережено ✓ ${brands} брендів${queries ? `, ${queries} запитів` : ' (без ключів — додай keyword/GEO)'}`
        : 'Список очищено — показую всі сайти';
      setTimeout(() => ($('watchmsg').textContent = ''), 3000);
    }
    loadData();
  });
}

function saveWatch() {
  const text = $('watchlist').value;
  applyWatch(parseWatchTargets(text), text);
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
      const text = String(reader.result);
      const targets = parseWatchTargets(text);
      if ($('watchmsg') && !targets.length) {
        $('watchmsg').style.color = '#f87171';
        $('watchmsg').textContent = 'У файлі не знайдено доменів';
        return;
      }
      applyWatch(targets, text);
    };
    reader.readAsText(file, 'utf-8');
  });
}

// Near-real-time: re-pull the latest sweep data every 60s so an open tab stays
// current between (and during) runs. Only the data + render refresh — the
// watchlist textarea is left alone so it never clobbers what you're typing.
if (typeof setInterval === 'function') setInterval(loadData, 60000);

loadWatch(loadData);
