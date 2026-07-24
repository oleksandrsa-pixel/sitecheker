// Rank Peek — competitors page.
//
// For each tracked query shows the FULL top-10 SERP: YOUR site highlighted, and
// every other result labeled (competitor / aggregator / your other site) with
// its full, copyable URL — so you can grab a link and file an abuse report
// without opening the page.

const $ = (id) => document.getElementById(id);

const NOISE = [
  'wikipedia.org', 'trustpilot.com', 'google.com', 'apps.apple.com', 'youtube.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'reddit.com', 'tiktok.com',
  'linkedin.com', 'pinterest.com', 'tripadvisor.com',
];
const hostMatches = (host, base) => {
  const h = (host || '').replace(/^www\./, '').toLowerCase();
  const b = (base || '').replace(/^www\./, '').toLowerCase();
  return !!h && !!b && (h === b || h.endsWith('.' + b));
};
const isNoise = (host) => NOISE.some((n) => hostMatches(host, n));

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
  noise: { cls: 'k-noise', label: 'агрегатор' },
  comp: { cls: 'k-comp', label: 'конкурент' },
};

// Build the classified SERP list for a target from its stored top-10 (falls
// back to the old competitors field for checks recorded before v0.8).
function buildSerp(c) {
  const list =
    Array.isArray(c.serpTop) && c.serpTop.length
      ? c.serpTop
      : Array.isArray(c.competitors)
        ? c.competitors.map((x) => ({ ...x, own: false }))
        : [];
  return list.map((x) => {
    let kind;
    if (hostMatches(x.host, c.domain)) kind = 'you';
    else if (x.own) kind = 'own';
    else if (isNoise(x.host)) kind = 'noise';
    else kind = 'comp';
    return { position: x.position, host: x.host, url: x.url || '', title: x.title || '', kind };
  });
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
        serp: buildSerp(c),
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
  $('sub').textContent = `${rows.length} з ${ROWS.length} запитів · повний топ видачі з підсвіткою вашого сайту`;
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
  const header = ['Мій сайт', 'Кейворд', 'Гео', 'Моя поз.', 'Дата/час', 'Позиція', 'Тип', 'Домен', 'Заголовок', 'URL'];
  const lines = [header.map(csvEscape).join(',')];
  ROWS.forEach((r) => {
    const my = r.error ? 'ERR' : r.position == null ? 'OUT' : r.position;
    if (!r.serp.length) {
      lines.push([r.site, r.keyword, r.geo, my, fmtTime(r.checkedAt), '', '', '', '(видачі не зчитано)', ''].map(csvEscape).join(','));
      return;
    }
    r.serp.forEach((x) => {
      const type = (KIND[x.kind] || KIND.comp).label;
      lines.push([r.site, r.keyword, r.geo, my, fmtTime(r.checkedAt), x.position, type, x.host, x.title, x.url].map(csvEscape).join(','));
    });
  });
  return `﻿sep=,\r\n${lines.join('\r\n')}`;
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
