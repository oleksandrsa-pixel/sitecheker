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

// Build the pivot from lastChecks (+ sweepTargets for keyword ordering, +
// history for the per-cell trend / "yesterday" reference).
function buildRows(lastChecks, sweepTargets, historyAll) {
  // Preferred keyword order per site (main keyword first, as stored in targets).
  const order = new Map(); // `${domain}|${gl}` -> [keyword, ...]
  (Array.isArray(sweepTargets) ? sweepTargets : []).forEach((t) => {
    if (!t || !t.domain || !t.gl) return;
    const k = `${registrable(t.domain)}|${t.gl}`;
    if (!order.has(k)) order.set(k, []);
    const arr = order.get(k);
    if (!arr.includes(t.keyword)) arr.push(t.keyword);
  });

  const hist = historyAll || {};
  const groups = new Map(); // `${domain}|${gl}` -> row
  Object.entries(lastChecks || {}).forEach(([key, c]) => {
    if (!c || !c.domain) return;
    const gl = c.gl || '';
    const gkey = `${registrable(c.domain)}|${gl}`;
    if (!groups.has(gkey)) {
      groups.set(gkey, {
        site: c.site || registrable(c.domain),
        domain: registrable(c.domain),
        geo: c.geo || (gl ? gl.toUpperCase() : ''),
        gl,
        lastChecked: c.checkedAt || '',
        _kw: new Map(), // keyword -> cell
      });
    }
    const row = groups.get(gkey);
    row._kw.set(c.keyword, {
      keyword: c.keyword,
      position: c.position,
      error: c.error || null,
      top1: c.top1 || null,
      checkedAt: c.checkedAt || '',
      prevPosition: c.prevPosition,
      yesterdayPosition: c.yesterdayPosition,
      hist: (hist[key] || []).slice(-8).map((h) => h.pos),
    });
    if (c.checkedAt && (!row.lastChecked || c.checkedAt > row.lastChecked)) {
      row.lastChecked = c.checkedAt;
    }
  });

  const rows = [];
  let maxKw = 0;
  for (const [gkey, row] of groups) {
    const preferred = order.get(gkey) || [];
    const present = [...row._kw.keys()];
    // Keywords in target order first, then any extras (shortest = brand first).
    const ordered = [
      ...preferred.filter((k) => row._kw.has(k)),
      ...present.filter((k) => !preferred.includes(k)).sort((a, b) => a.length - b.length),
    ];
    row.keywords = ordered.map((k) => row._kw.get(k));
    delete row._kw;
    maxKw = Math.max(maxKw, row.keywords.length);
    rows.push(row);
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
  // Any keyword out of top-5 (or missing / errored) makes the row "problematic".
  return row.keywords.some((c) => c.error || c.position == null || c.position > 5);
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
  $('sub').textContent = `${view.length} з ${ROWS.length} сайтів · показано ${
    view.reduce((n, r) => n + r.keywords.length, 0)
  } перевірок`;
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
        kwCells.push(
          `<td class="kwcell">${
            c
              ? `<div class="kw" title="${c.keyword}">${c.keyword}</div>` +
                `<div class="poscell"${histTitle(c)}>${pill(c)}${trendHtml(c)}</div>` +
                prevLine(c)
              : '<span class="pill p-none">—</span>'
          }</td>`,
        );
      }
      return (
        '<tr>' +
        `<td class="site">${r.site}</td>` +
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
  const allCells = ROWS.flatMap((r) => r.keywords);
  const total = allCells.length;
  const top3 = allCells.filter((c) => typeof c.position === 'number' && c.position <= 3).length;
  const top5 = allCells.filter((c) => typeof c.position === 'number' && c.position <= 5).length;
  const out = allCells.filter((c) => !c.error && c.position == null).length;
  const err = allCells.filter((c) => c.error).length;
  const cards = [
    { n: ROWS.length, l: 'Сайтів' },
    { n: total, l: 'Перевірок' },
    { n: top3, l: 'У топ-3' },
    { n: top5, l: 'У топ-5' },
    { n: out, l: 'Поза видачею' },
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
  if (!c) return '';
  if (c.error) return 'ERR';
  if (c.position == null) return 'OUT';
  return c.position;
}

function yesterdayText(cell) {
  if (!cell) return '';
  const y = cell.yesterdayPosition;
  if (y === undefined) return '';
  return y == null ? 'OUT' : `#${y}`;
}

function deltaText(cell) {
  if (!cell) return '';
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
