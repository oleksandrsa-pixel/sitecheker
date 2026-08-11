// Drop Finder — minimal popup. Reuses the same background engine and storage
// keys as the full tracker, but exposes ONLY the drops workflow: connect the
// Google Sheet, run the drops sweep, open the drops page.

const $ = (id) => document.getElementById(id);

// ---- Actions ---------------------------------------------------------------

$('runactive').addEventListener('click', () => {
  $('runmsg').style.color = 'var(--muted)';
  $('runmsg').textContent = '🎯 Запускаю прогін дропів…';
  chrome.runtime.sendMessage({ type: 'rankpeek:startActive' }, (resp) => {
    if (chrome.runtime.lastError) {
      $('runmsg').style.color = '#f87171';
      $('runmsg').textContent =
        `Фонова служба не відповіла (${chrome.runtime.lastError.message}). Відкрий chrome://extensions → ↻ на картці.`;
      return;
    }
    if (resp && resp.ok) {
      $('runmsg').style.color = '#34d399';
      $('runmsg').textContent = '🎯 Прогін пішов — дивись статус вище.';
    } else if (resp && resp.reason === 'busy') {
      $('runmsg').style.color = '#fbbf24';
      $('runmsg').textContent = 'Прогін уже йде — зачекай, поки завершиться.';
    } else {
      $('runmsg').style.color = '#f87171';
      $('runmsg').textContent = 'Немає активних брендів — синхронізуй таблицю (постав * у вкладці).';
    }
    setTimeout(() => ($('runmsg').textContent = ''), 4500);
  });
});

$('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'rankpeek:stop' }));

$('drops').addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('drops.html') }),
);

// ---- Live status -----------------------------------------------------------

function render() {
  chrome.storage.local.get(['sweep', 'dropWatch'], (v) => {
    const s = v.sweep;
    const targets = Array.isArray(v.dropWatch) ? v.dropWatch : [];
    const badge = $('badge');
    badge.style.background = '';
    badge.style.color = '';

    if (s?.running && (s.paused || s.blocked)) {
      badge.textContent = s.blocked ? '⏸ CAPTCHA' : '⏸ пауза';
      badge.className = 'badge';
      badge.style.background = 'rgba(248,113,113,.16)';
      badge.style.color = '#f87171';
    } else if (s?.running) {
      badge.textContent = `прогін ${s.results?.length ?? 0}/${s.targets?.length ?? targets.length}`;
      badge.className = 'badge run';
    } else {
      badge.textContent = 'готово';
      badge.className = 'badge';
    }

    if (s?.running && s.blocked) {
      const cur = s.current?.target;
      $('status').textContent =
        `Google показав перевірку${cur ? ` на «${cur.keyword}»` : ''}. Розвʼяжи CAPTCHA у відкритій вкладці — прогін продовжиться сам.`;
    } else if (s?.running && s.paused) {
      $('status').textContent = 'Пауза — прогін відновиться автоматично.';
    } else if (s?.running) {
      const cur = s.current?.target;
      $('status').textContent =
        `Іде прогін… ${s.results?.length ?? 0}/${s.targets?.length ?? 0}` +
        (cur ? ` — зараз «${cur.keyword}» (${cur.geo || cur.gl})` : '');
    } else if (s && s.results?.length) {
      $('status').textContent = `Останній прогін: ${s.results.length} перевірок. Відкрий 👁 Дропи.`;
    } else if (targets.length) {
      $('status').textContent = `${targets.length} активних запитів · натисни «🎯 Прогін дропів»`;
    } else {
      $('status').textContent = 'Підключи таблицю нижче й натисни «Синхронізувати зараз».';
    }
  });
}

// ---- Google Sheet ----------------------------------------------------------

$('savesheet').addEventListener('click', () => {
  const cfg = {
    sheetId: $('sheeturl').value.trim(),
    sheetApiKey: $('sheetkey').value.trim(),
    sheetSync: $('sheetsync').checked,
    sheetSyncMin: Math.max(5, Number($('sheetmin').value) || 30),
    sheetKwExtra: $('sheetkw').value.trim(),
  };
  chrome.storage.local.set(cfg, () => {
    chrome.runtime.sendMessage({ type: 'rankpeek:schedule' }); // (re)arm the sync alarm
    $('sheetmsg').style.color = '#16a34a';
    $('sheetmsg').textContent = cfg.sheetSync
      ? `Збережено ✓ · авто кожні ${cfg.sheetSyncMin} хв`
      : 'Збережено ✓ · авто-синхронізацію вимкнено';
    setTimeout(() => ($('sheetmsg').textContent = ''), 3000);
  });
});

$('syncsheet').addEventListener('click', () => {
  chrome.storage.local.set(
    {
      sheetId: $('sheeturl').value.trim(),
      sheetApiKey: $('sheetkey').value.trim(),
      sheetKwExtra: $('sheetkw').value.trim(),
    },
    () => {
      $('sheetmsg').style.color = '#555';
      $('sheetmsg').textContent = 'Синхронізую…';
      chrome.runtime.sendMessage({ type: 'rankpeek:syncSheet' }, (resp) => {
        if (chrome.runtime.lastError) {
          $('sheetmsg').style.color = '#dc2626';
          $('sheetmsg').textContent = `Фонова служба не відповіла (${chrome.runtime.lastError.message}).`;
          return;
        }
        if (resp && resp.ok) {
          $('sheetmsg').style.color = '#16a34a';
          $('sheetmsg').textContent = `Готово ✓ ${resp.activeTabs} вкладок · ${resp.projects} проєктів · ${resp.queries} запитів · ${resp.drops} дропів`;
        } else {
          $('sheetmsg').style.color = '#dc2626';
          $('sheetmsg').textContent = 'Помилка: ' + ((resp && resp.error) || 'перевір посилання / ключ / доступ');
        }
      });
    },
  );
});

// ---- Telegram (optional drop alerts) ---------------------------------------

function tgHint(err) {
  const e = String(err || '').toLowerCase();
  if (e.includes('chat not found')) return 'Відкрий бота в Telegram і натисни Start; chat_id має бути ЧИСЛО.';
  if (e.includes('initiate') || e.includes('bot can')) return 'Спершу натисни Start у бота — він не може написати першим.';
  if (e.includes('token невірн') || e.includes('unauthorized') || e.includes('http 401') || e.includes('http 404')) {
    return 'Скопіюй Bot token заново з @BotFather — без пробілів.';
  }
  if (e.includes('мереж')) return 'Перевір інтернет / VPN — можливо, Telegram недоступний у мережі.';
  return 'Перевір Bot token і chat_id.';
}

$('savetg').addEventListener('click', () => {
  chrome.storage.local.set(
    {
      telegramToken: $('tgtoken').value.trim(),
      telegramChatId: $('tgchat').value.trim(),
      dropAlerts: $('dropalerts').checked,
    },
    () => {
      $('tgmsg').style.color = '#16a34a';
      $('tgmsg').textContent = 'Збережено ✓';
      setTimeout(() => ($('tgmsg').textContent = ''), 3000);
    },
  );
});

$('testtg').addEventListener('click', () => {
  chrome.storage.local.set(
    { telegramToken: $('tgtoken').value.trim(), telegramChatId: $('tgchat').value.trim() },
    () => {
      $('tgmsg').style.color = '#555';
      $('tgmsg').textContent = 'Надсилаю…';
      chrome.runtime.sendMessage({ type: 'rankpeek:testTg' }, (resp) => {
        if (chrome.runtime.lastError) {
          $('tgmsg').style.color = '#dc2626';
          $('tgmsg').textContent =
            `Фонова служба не відповіла (${chrome.runtime.lastError.message}). Відкрий chrome://extensions → ↻.`;
          return;
        }
        if (resp?.ok) {
          $('tgmsg').style.color = '#16a34a';
          $('tgmsg').textContent = 'Надіслано ✓ — перевір Telegram';
          return;
        }
        $('tgmsg').style.color = '#dc2626';
        const err = resp?.error || 'невідома помилка';
        $('tgmsg').textContent = `Помилка: ${err}. ${tgHint(err)}`;
      });
    },
  );
});

// ---- Init ------------------------------------------------------------------

function loadConfig() {
  chrome.storage.local.get(
    ['sheetId', 'sheetApiKey', 'sheetSync', 'sheetSyncMin', 'sheetKwExtra', 'telegramToken', 'telegramChatId', 'dropAlerts'],
    (v) => {
      $('sheeturl').value = v.sheetId || '';
      $('sheetkey').value = v.sheetApiKey || '';
      $('sheetsync').checked = Boolean(v.sheetSync);
      $('sheetmin').value = v.sheetSyncMin != null ? v.sheetSyncMin : 30;
      $('sheetkw').value = v.sheetKwExtra !== undefined ? v.sheetKwExtra : 'casino';
      $('tgtoken').value = v.telegramToken || '';
      $('tgchat').value = v.telegramChatId || '';
      $('dropalerts').checked = v.dropAlerts !== false;
    },
  );
}

loadConfig();
render();
setInterval(render, 700);
