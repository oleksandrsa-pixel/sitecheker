// Rank Peek content script.
// Reads the Google SERP DOM that the USER is currently looking at (their
// session, login, geo extension — exactly their view), extracts the ordered
// organic results, and reports the position of each tracked domain.

(() => {
  const DEFAULT_TARGETS = [
    'nvcasino-frances.com',
    'casea-casino1.com',
    'casea-online-casino.com',
    'betscore-1casino.com',
    'magneticslotcasino.com',
  ];

  const registrable = (host) => host.replace(/^www\./, '').toLowerCase();

  function parseOrganic() {
    const scope =
      document.querySelector('#rso') || document.querySelector('#search') || document.body;
    const seenBlocks = new Set();
    const seenHosts = new Set();
    const results = [];

    scope.querySelectorAll('h3').forEach((h3) => {
      const anchor = h3.closest('a[href]');
      if (!anchor) return;

      // One entry per result block (a block may repeat the domain in sitelinks).
      const block = h3.closest('[data-hveid]') || h3.closest('.g') || anchor;
      if (seenBlocks.has(block)) return;

      let host;
      try {
        const u = new URL(anchor.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        host = registrable(u.hostname);
      } catch {
        return;
      }
      // Skip only the search engine host itself (google.com, google.fr, ...),
      // but KEEP result subdomains like play.google.com / maps.google.com,
      // which are real SERP entries — excluding them would offset positions.
      if (!host || /^google\.[a-z.]+$/.test(host)) return;
      if (seenHosts.has(host)) return; // skip duplicate host blocks

      seenBlocks.add(block);
      seenHosts.add(host);
      results.push({
        position: results.length + 1,
        host,
        url: anchor.href,
        title: h3.textContent.trim(),
      });
    });

    return results;
  }

  const matchTarget = (host, target) => {
    const h = registrable(host);
    const t = registrable(target);
    return h === t || h.endsWith('.' + t);
  };

  // Google sometimes injects an "unusual traffic" / CAPTCHA wall straight onto
  // the /search page (no redirect). Detect it so the background can pause the
  // sweep and let the user solve it once, instead of silently timing out.
  function looksBlocked() {
    if (/\/sorry\//i.test(location.pathname)) return true;
    if (
      document.querySelector(
        'form[action*="/sorry"], iframe[src*="recaptcha"], iframe[src*="/sorry/"], #recaptcha, #captcha-form, div.g-recaptcha',
      )
    ) {
      return true;
    }
    const txt = (document.body?.innerText || '').slice(0, 800).toLowerCase();
    return /unusual traffic|not a robot|our systems have detected|does not have permission|client does not have|that.{0,3}s an error|незвичайний трафік|незвичний трафік|підозрілий трафік|подозрительный трафик|необычный трафик/.test(
      txt,
    );
  }

  function getTargets() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['targets'], (v) => {
          resolve(v && Array.isArray(v.targets) && v.targets.length ? v.targets : DEFAULT_TARGETS);
        });
      } catch {
        resolve(DEFAULT_TARGETS);
      }
    });
  }

  function renderOverlay(inner) {
    let box = document.getElementById('rank-peek-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rank-peek-box';
      box.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:360px;' +
        'background:#0b0b0f;color:#e5e7eb;font:12px/1.5 ui-monospace,Consolas,monospace;' +
        'padding:10px 12px;border:1px solid #333;border-radius:10px;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.5);opacity:.97';
      document.documentElement.appendChild(box);
    }
    box.innerHTML = inner;
  }

  async function run() {
    // Stop early on a challenge page and tell the background to pause + surface
    // this tab for manual solving.
    if (looksBlocked()) {
      try {
        chrome.runtime.sendMessage({ type: 'rankpeek:blocked' });
      } catch {
        /* not in an extension context / worker asleep */
      }
      return true; // stop retrying — this isn't a results page
    }

    const results = parseOrganic();
    if (results.length === 0) return false;

    const targets = await getTargets();
    const q = new URL(location.href).searchParams.get('q') || '';
    const gl = new URL(location.href).searchParams.get('gl') || '';

    const hits = [];
    for (const t of targets) {
      const found = results.find((r) => matchTarget(r.host, t));
      if (found) hits.push({ target: t, position: found.position });
    }

    const hitHtml = hits.length
      ? hits
          .map((h) => `<div style="color:#4ade80">● ${h.target} → <b>#${h.position}</b></div>`)
          .join('')
      : '<div style="color:#f87171">жоден відстежуваний домен не знайдено в органіці</div>';

    const listHtml = results
      .slice(0, 10)
      .map((r) => {
        const hit = hits.some((h) => matchTarget(r.host, h.target));
        return `<div style="${hit ? 'color:#4ade80;font-weight:bold' : ''}">${String(
          r.position,
        ).padStart(2)}. ${r.host}</div>`;
      })
      .join('');

    renderOverlay(
      `<div style="font-weight:bold;margin-bottom:6px">Rank Peek — «${q}»${gl ? ' · gl=' + gl : ''}</div>` +
        hitHtml +
        `<div style="margin:8px 0 2px;color:#8b8b8b">органіка (топ-10):</div>` +
        listHtml +
        `<div style="margin-top:6px;color:#6b7280">зчитано ${results.length} орг. результатів із твого екрана</div>`,
    );

    // During an automated sweep the background worker opened this tab and is
    // waiting for the parsed results. Sending is harmless during manual
    // browsing (the background ignores messages when no sweep is running).
    try {
      chrome.runtime.sendMessage({ type: 'rankpeek:serp', payload: { q, gl, results } });
    } catch {
      /* not in an extension context / worker asleep */
    }

    // Also expose full data to the page console for verification.
    // eslint-disable-next-line no-console
    console.table(results);
    return true;
  }

  // Google hydrates parts of the SERP after load — retry briefly until results appear.
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    const ok = await run();
    if (ok || tries > 10) clearInterval(timer);
  }, 400);
})();
