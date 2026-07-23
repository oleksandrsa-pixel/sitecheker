// Rank Peek — competitors page.
//
// For each tracked target shows: brand, keyword, geo, MY position, and the top
// competitors (rank in SERP + domain + title), read from the per-target
// `competitors` saved on each check. A structured in-app view instead of a
// crammed CSV.

const $ = (id) => document.getElementById(id);

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function myPill(c) {
  if (c.error) return '<span class="pill p-bad" title="' + esc(c.error) + '">err</span>';
  if (c.position == null) return '<span class="pill p-bad">OUT</span>';
  const cls = c.position <= 3 ? 'p-good' : c.position <= 5 ? 'p-mid' : 'p-bad';
  return `<span class="pill ${cls}">#${c.position}</span>`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let ROWS = [];

function load() {
  chrome.storage.local.get(['lastChecks'], (v) => {
    ROWS = Object.values(v.lastChecks || {})
      .map((c) => ({
        site: c.site || c.domain,
        keyword: c.keyword,
        geo: c.geo || (c.gl ? c.gl.toUpperCase() : ''),
        gl: c.gl,
        domain: c.domain,
        position: c.position,
        error: c.error || null,
        checkedAt: c.checkedAt || '',
        competitors: Array.isArray(c.competitors) ? c.competitors : [],
      }))
      .sort((a, b) =>
        (a.site || '').localeCompare(b.site || '') ||
        (a.geo || '').localeCompare(b.geo || '') ||
        (a.keyword || '').localeCompare(b.keyword || ''),
      );
    populateGeo();
    render();
  });
}

function populateGeo() {
  const geos = [...new Set(ROWS.map((r) => r.geo).filter(Boolean))].sort();
  $('geo').innerHTML =
    '<option value="">Усі гео</option>' +
    geos.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
}

function view() {
  const q = $('q').value.trim().toLowerCase();
  const geo = $('geo').value;
  const onlybad = $('onlybad').checked;
  return ROWS.filter((r) => {
    if (geo && r.geo !== geo) return false;
    if (onlybad && !(r.error || r.position == null || r.position > 5)) return false;
    if (!q) return true;
    const hay = [r.site, r.keyword, r.geo, ...r.competitors.map((c) => c.host)].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function render() {
  const rows = view();
  $('sub').textContent = `${rows.length} з ${ROWS.length} цілей · топ-5 конкурентів по кожному запиту`;
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
      const comps = r.competitors.length
        ? '<table class="comp">' +
          r.competitors
            .map(
              (c) =>
                '<tr>' +
                `<td class="rank">#${c.position}</td>` +
                `<td class="dom">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.host)}</a>` : esc(c.host)}</td>` +
                `<td class="title">${esc(c.title)}</td>` +
                '</tr>',
            )
            .join('') +
          '</table>'
        : `<div class="none">${r.error ? 'Перевірка з помилкою (' + esc(r.error) + ')' : 'Конкурентів не знайдено'}</div>`;
      return (
        '<div class="card">' +
        '<div class="head">' +
        `<span class="brand">${esc(r.site)}</span>` +
        `<span class="kw">«${esc(r.keyword)}»</span>` +
        `<span class="geo">${esc(r.geo)}</span>` +
        `<span class="me"><span class="lbl">моя позиція:</span> ${myPill(r)}` +
        (r.checkedAt ? ` <span class="badge">${fmtTime(r.checkedAt)}</span>` : '') +
        '</span>' +
        '</div>' +
        comps +
        '</div>'
      );
    })
    .join('');
}

// ---- CSV export (structured, Excel-friendly) -------------------------------

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv() {
  const header = ['Мій сайт', 'Кейворд', 'Гео', 'Моя поз.', 'Дата/час', '№', 'Позиція в SERP', 'Домен конкурента', 'Заголовок', 'URL'];
  const lines = [header.map(csvEscape).join(',')];
  ROWS.forEach((r) => {
    const my = r.error ? 'ERR' : r.position == null ? 'OUT' : r.position;
    if (!r.competitors.length) {
      lines.push([r.site, r.keyword, r.geo, my, fmtTime(r.checkedAt), '', '', '(конкурентів не знайдено)', '', ''].map(csvEscape).join(','));
      return;
    }
    r.competitors.forEach((c, i) => {
      lines.push([r.site, r.keyword, r.geo, my, fmtTime(r.checkedAt), i + 1, c.position, c.host, c.title, c.url].map(csvEscape).join(','));
    });
  });
  return `﻿sep=,\r\n${lines.join('\r\n')}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

$('csv').addEventListener('click', () => {
  if (!ROWS.length) return;
  const url = URL.createObjectURL(new Blob([buildCsv()], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `rank-peek-competitors-${stamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

$('q').addEventListener('input', render);
$('geo').addEventListener('change', render);
$('onlybad').addEventListener('change', render);
$('refresh').addEventListener('click', load);

load();
