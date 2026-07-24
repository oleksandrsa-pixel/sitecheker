// Rank Peek — structured report page.
//
// Turns the flat per-(site x keyword x geo) checks into a readable pivot: ONE
// row per site+geo, with a column per keyword (keyword 1, keyword 2, …) showing
// the position. This is the "open it and see each site's position per keyword"
// view — much clearer than the flat CSV where every keyword is its own row.

const $ = (id) => document.getElementById(id);

const registrable = (h) => (h || '').replace(/^www\./, '').toLowerCase();

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

function pill(cell) {
  if (!cell) return '<span class="pill p-none">—</span>';
  if (cell.error) return `<span class="pill p-bad" title="${cell.error}">err</span>`;
  if (cell.position == null) return '<span class="pill p-bad">OUT</span>';
  const cls = cell.position <= 3 ? 'p-good' : cell.position <= 5 ? 'p-mid' : 'p-bad';
  const t = cell.top1 ? ` title="#1: ${cell.top1}"` : '';
  return `<span class="pill ${cls}"${t}>#${cell.position}</span>`;
}

// Baseline for the trend arrow: the position ~24h ago if we have it, otherwise
// the previous sweep. Returns { base, label } where base may be number|null|undefined.
function trendBase(cell) {
  if (cell.yesterdayPosition !== undefined) return { base: cell.yesterdayPosition, label: 'вчора' };
  if (cell.prevPosition !== undefined) return { base: cell.prevPosition, label: 'мин.' };
  return { base: undefined, label: '' };
}

// Colored arrow showing movement vs the baseline (lower rank number = better).
function trendHtml(cell) {
  const { base } = trendBase(cell);
  const cur = cell.position;
  if (base === undefined) return '<span class="tr new" title="перша перевірка">🆕</span>';
  if (cur == null) {
    return base == null ? '' : '<span class="tr down" title="випав із видачі">▼OUT</span>';
  }
  if (base == null) return '<span class="tr up" title="повернувся у видачу">↩</span>';
  if (cur < base) return `<span class="tr up" title="покращення на ${base - cur}">▲${base - cur}</span>`;
  if (cur > base) return `<span class="tr down" title="падіння на ${cur - base}">▼${cur - base}</span>`;
  return '<span class="tr flat" title="без змін">=</span>';
}

// Small "yesterday: #N" reference line under the pill.
function prevLine(cell) {
  const y = cell.yesterdayPosition;
  if (y === undefined) return '<div class="prev">вчора: —</div>';
  return `<div class="prev">вчора: ${y == null ? 'OUT' : '#' + y}</div>`;
}

// Recent history as a tooltip string, e.g. "#5 → #5 → #4 → #3".
function histTitle(cell) {
  if (!cell.hist || !cell.hist.length) return '';
  const s = cell.hist.map((p) => (p == null ? 'OUT' : '#' + p)).join(' → ');
  return ` title="історія: ${s}"`;
}

// State kept in memory so search/filter/sort don't re-hit storage.
let ROWS = []; // [{ site, domain, geo, gl, lastChecked, keywords: [{keyword, position, error, top1, checkedAt}] }]
let MAX_KW = 0;
let sortKey = 'site';
let sortDir = 1;

// Site-level status from its keyword cells (mirrors background siteAggregate):
// 'in' = ranks <=5 by at least one keyword; 'out' = all checked keywords out
// AND nothing pending; 'pending' = still waiting on some keyword; 'unknown' =
// only errors so far.
function siteStatus(keywords) {
  const checked = keywords.filter((k) => !k.pending);
  const nonErr = checked.filter((k) => !k.error);
  if (!checked.length) return 'pending';
  if (nonErr.some((k) => k.position != null && k.position <= 5)) return 'in';
  if (keywords.some((k) => k.pending)) return 'pending';
  if (!nonErr.length) return 'unknown';
  return 'out';
}

// Build the pivot: ONE row per site (domain+geo), a column per keyword. Seeded
// from sweepTargets so BOTH keyword columns always show (pending as "—" until
// checked), then overlaid with actual checks + history.
function buildRows(lastChecks, sweepTargets, historyAll) {
  const hist = historyAll || {};
  const groups = new Map();
  const ensure = (site, domain, geo, gl) => {
    const key = `${registrable(domain)}|${gl || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        site: site || registrable(domain),
        domain: registrable(domain),
        geo: geo || (gl ? gl.toUpperCase() : ''),
        gl: gl || '',
        lastChecked: '',
        order: [],
        kw: new Map(),
      });
    }
    return groups.get(key);
  };

  // 1) Seed every configured target so both keyword columns always appear.
  (Array.isArray(sweepTargets) ? sweepTargets : []).forEach((t) => {
    if (!t || !t.domain || !t.keyword) return;
    const g = ensure(t.site, t.domain, t.geo, t.gl);
    if (!g.kw.has(t.keyword)) {
      g.kw.set(t.keyword, { keyword: t.keyword, pending: true });
      g.order.push(t.keyword);
    }
  });

  // 2) Overlay actual checks.
  Object.entries(lastChecks || {}).forEach(([key, c]) => {
    if (!c || !c.domain) return;
    const g = ensure(c.site, c.domain, c.geo, c.gl);
    if (!g.kw.has(c.keyword)) g.order.push(c.keyword);
    g.kw.set(c.keyword, {
      keyword: c.keyword,
      position: c.position,
      error: c.error || null,
      top1: c.top1 || null,
      checkedAt: c.checkedAt || '',
      prevPosition: c.prevPosition,
      yesterdayPosition: c.yesterdayPosition,
      hist: (hist[key] || []).slice(-8).map((h) => h.pos),
      pending: false,
    });
    if (c.checkedAt && (!g.lastChecked || c.checkedAt > g.lastChecked)) g.lastChecked = c.checkedAt;
  });

  const rows = [];
  let maxKw = 0;
  for (const [, g] of groups) {
    g.keywords = g.order.map((k) => g.kw.get(k));
    delete g.kw;
    delete g.order;
    g.status = siteStatus(g.keywords);
    maxKw = Math.max(maxKw, g.keywords.length);
    rows.push(g);
  }
  MAX_KW = Math.max(1, maxKw);
  return rows;
}

function bestPos(row) {
  // Best (lowest) numeric position across a row's keywords, for sorting.
  const nums = row.keywords.map((c) => c.position).filter((p) => typeof p === 'number');
  return nums.length ? Math.min(...nums) : Infinity;
}

function rowIsBad(row) {
  // "Problematic" = the SITE is out of top-5 by ALL its keywords.
  return row.status === 'out';
}

function applyView() {
  const q = $('q').value.trim().toLowerCase();
  const geo = $('geo').value;
  const onlybad = $('onlybad').checked;

  let view = ROWS.filter((r) => {
    if (geo && r.geo !== geo) return false;
    if (onlybad && !rowIsBad(r)) return false;
    if (!q) return true;
    const hay = [r.site, r.domain, r.geo, ...r.keywords.map((c) => c.keyword)]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  view.sort((a, b) => {
    let av;
    let bv;
    if (sortKey === 'pos') {
      av = bestPos(a);
      bv = bestPos(b);
    } else if (sortKey === 'when') {
      av = a.lastChecked || '';
      bv = b.lastChecked || '';
    } else {
      av = (a[sortKey] || '').toString().toLowerCase();
      bv = (b[sortKey] || '').toString().toLowerCase();
    }
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });

  renderHead();
  renderBody(view);
  const shownChecks = view.reduce((n, r) => n + r.keywords.filter((c) => !c.pending).length, 0);
  $('sub').textContent = `${view.length} з ${ROWS.length} сайтів · показано ${shownChecks} перевірок`;
}

function statusPill(status) {
  if (status === 'in') return '<span class="sstatus s-in">🟢 в топі</span>';
  if (status === 'out') return '<span class="sstatus s-out">🔴 поза топ-5</span>';
  if (status === 'unknown') return '<span class="sstatus s-un">⚠ помилка</span>';
  return '<span class="sstatus s-pend">⏳ перевіряю</span>';
}

function renderHead() {
  const kwHeaders = [];
  for (let i = 0; i < MAX_KW; i += 1) kwHeaders.push(`<th>Кейворд ${i + 1}</th>`);
  $('tbl').querySelector('thead').innerHTML =
    '<tr>' +
    `<th data-sort="site">Сайт</th>` +
    `<th data-sort="domain">Домен</th>` +
    `<th data-sort="geo">Гео</th>` +
    kwHeaders.join('') +
    `<th data-sort="when">Остання перевірка</th>` +
    '</tr>';
  $('tbl')
    .querySelectorAll('th[data-sort]')
    .forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-sort');
        if (sortKey === k) sortDir *= -1;
        else {
          sortKey = k;
          sortDir = 1;
        }
        applyView();
      });
    });
}

function renderBody(view) {
  const tbody = $('tbl').querySelector('tbody');
  if (!view.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="${MAX_KW + 4}">Нема даних. Зроби прохід у розширенні (▶ Прохід), тоді онови цю сторінку.</td></tr>`;
    return;
  }
  tbody.innerHTML = view
    .map((r) => {
      const kwCells = [];
      for (let i = 0; i < MAX_KW; i += 1) {
        const c = r.keywords[i];
        let inner;
        if (!c) {
          inner = '<span class="pill p-none">—</span>';
        } else if (c.pending) {
          inner =
            `<div class="kw" title="${c.keyword}">${c.keyword}</div>` +
            `<span class="pill p-none">—</span><div class="prev">очікує</div>`;
        } else {
          inner =
            `<div class="kw" title="${c.keyword}">${c.keyword}</div>` +
            `<div class="poscell"${histTitle(c)}>${pill(c)}${trendHtml(c)}</div>` +
            prevLine(c);
        }
        kwCells.push(`<td class="kwcell">${inner}</td>`);
      }
      return (
        '<tr>' +
        `<td class="site">${r.site}<div>${statusPill(r.status)}</div></td>` +
        `<td class="domain">${r.domain}</td>` +
        `<td class="geo">${r.geo}</td>` +
        kwCells.join('') +
        `<td class="when">${fmtTime(r.lastChecked)}</td>` +
        '</tr>'
      );
    })
    .join('');
}

function renderCards() {
  const cells = ROWS.flatMap((r) => r.keywords).filter((c) => !c.pending);
  const total = cells.length;
  const top5 = cells.filter((c) => typeof c.position === 'number' && c.position <= 5).length;
  const err = cells.filter((c) => c.error).length;
  const sitesOut = ROWS.filter((r) => r.status === 'out').length; // key metric = alertable
  const sitesIn = ROWS.filter((r) => r.status === 'in').length;
  const cards = [
    { n: ROWS.length, l: 'Сайтів' },
    { n: sitesIn, l: 'Сайтів у топі' },
    { n: sitesOut, l: 'Сайтів поза топ' },
    { n: total, l: 'Перевірок' },
    { n: top5, l: 'Ключів у топ-5' },
    { n: err, l: 'Помилки' },
  ];
  $('cards').innerHTML = cards
    .map((c) => `<div class="stat"><div class="n">${c.n}</div><div class="l">${c.l}</div></div>`)
    .join('');
}

function populateGeo() {
  const geos = [...new Set(ROWS.map((r) => r.geo).filter(Boolean))].sort();
  const sel = $('geo');
  sel.innerHTML =
    '<option value="">Усі гео</option>' +
    geos.map((g) => `<option value="${g}">${g}</option>`).join('');
}

// ---- structured CSV (pivot) ------------------------------------------------

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function posText(c) {
  if (!c || c.pending) return '';
  if (c.error) return 'ERR';
  if (c.position == null) return 'OUT';
  return c.position;
}

function yesterdayText(cell) {
  if (!cell || cell.pending) return '';
  const y = cell.yesterdayPosition;
  if (y === undefined) return '';
  return y == null ? 'OUT' : `#${y}`;
}

function deltaText(cell) {
  if (!cell || cell.pending) return '';
  const { base } = trendBase(cell);
  const cur = cell.position;
  if (base === undefined) return 'new';
  if (cur == null) return base == null ? '' : '▼OUT';
  if (base == null) return '↩';
  if (cur < base) return `▲${base - cur}`;
  if (cur > base) return `▼${cur - base}`;
  return '=';
}

function buildPivotCsv() {
  const header = ['Сайт', 'Домен', 'Гео'];
  for (let i = 0; i < MAX_KW; i += 1) {
    header.push(`Кейворд ${i + 1}`, `Позиція ${i + 1}`, `Вчора ${i + 1}`, `Зміна ${i + 1}`);
  }
  header.push('Остання перевірка');
  const lines = [header.map(csvEscape).join(',')];
  ROWS.forEach((r) => {
    const cols = [r.site, r.domain, r.geo];
    for (let i = 0; i < MAX_KW; i += 1) {
      const c = r.keywords[i];
      cols.push(c ? c.keyword : '', posText(c), yesterdayText(c), deltaText(c));
    }
    cols.push(fmtTime(r.lastChecked));
    lines.push(cols.map(csvEscape).join(','));
  });
  // BOM (UTF-8/Cyrillic) + `sep=,` hint so Excel splits into columns on open
  // regardless of the machine's list-separator locale.
  return `﻿sep=,\r\n${lines.join('\r\n')}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}`;
}

$('csv').addEventListener('click', () => {
  if (!ROWS.length) return;
  const url = URL.createObjectURL(new Blob([buildPivotCsv()], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `rank-peek-report-${stamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

function load() {
  chrome.storage.local.get(['lastChecks', 'sweepTargets', 'history'], (v) => {
    ROWS = buildRows(v.lastChecks || {}, v.sweepTargets || [], v.history || {});
    renderCards();
    populateGeo();
    applyView();
  });
}

$('q').addEventListener('input', applyView);
$('geo').addEventListener('change', applyView);
$('onlybad').addEventListener('change', applyView);
$('refresh').addEventListener('click', load);

load();
