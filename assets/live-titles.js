/* Live page titles for the Schema tab.

   The browser can't read other websites, so the sheet's llms Apps Script
   fetches each page's <title> (through the "llms queue" tab) and keeps it
   in the "live titles" tab. This asks for titles that are missing or older
   than a week when a tab loads, and on "Refresh live titles". Titles show
   in place as soon as they arrive; the list isn't redrawn. */
(function () {
  const cfg = window.SHEET_CONFIG;
  if (!cfg || !cfg.enabled) return;
  const $ = id => document.getElementById(id);
  const Q = 'llms queue', STALE = 7 * 864e5, CHUNK = 40;
  const app = () => window.SchemaApp || {};
  const enc = encodeURIComponent;
  const a1 = (tab, r) => "'" + tab.replace(/'/g, "''") + "'!" + r;
  let busy = false;
  const asked = {};   // tab -> true once titles were asked for this session

  function status(text) {
    const s = $('lt-status');
    if (s) { s.textContent = text || ''; s.hidden = !text; }
  }

  async function queue(urls) {
    const id = 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    let who = '';
    try { who = localStorage.getItem('llms-name') || ''; } catch (e) { /* private window */ }
    await app().sheet.api('/values/' + enc(a1(Q, 'A:J')) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[id, new Date().toISOString(), who, 'schema', 'titles', urls.join(' '), 'Waiting', '', '', '']] })
    }).catch(e => { throw new Error(/Unable to parse range/i.test(e.message) ? 'the sheet’s llms Apps Script isn’t set up yet (no “llms queue” tab)' : e.message); });
    return id;
  }

  async function waitFor(ids) {
    const started = Date.now();
    const left = new Set(ids);
    let failed = 0;
    while (left.size) {
      await new Promise(r => setTimeout(r, 6000));
      const r = await app().sheet.api('/values/' + enc(a1(Q, 'A:J')));
      (r.values || []).forEach(x => { if (left.has(x[0]) && (x[6] === 'Done' || x[6] === 'Failed')) { left.delete(x[0]); if (x[6] === 'Failed') failed++; } });
      status('Fetching live titles… ' + (ids.length - left.size) + ' of ' + ids.length + ' batches done');
      if (Date.now() - started > 15 * 60000) throw new Error('the sheet’s script hasn’t finished after 15 minutes. Check that the latest llms Apps Script is pasted and its timer runs (run llmsSetup).');
    }
    return failed;
  }

  // A titles job already waiting or running (another tab, another person)? Don't add another.
  async function pending() {
    const r = await app().sheet.api('/values/' + enc(a1(Q, 'A:J'))).catch(() => ({ values: [] }));
    return (r.values || []).some(x => x[4] === 'titles' && (x[6] === 'Waiting' || x[6] === 'Running') && Date.now() - Date.parse(x[1]) < 30 * 60000);
  }

  async function refresh(pages) {
    if (busy) return;
    const urls = pages.map(p => p.url).filter(u => /^https?:\/\//i.test(u));
    if (!urls.length) return;
    busy = true;
    const btn = $('lt-refresh'); if (btn) btn.disabled = true;
    status('Fetching live titles for ' + urls.length + ' page' + (urls.length > 1 ? 's' : '') + '… (the sheet’s script runs once a minute)');
    try {
      const ids = [];
      for (let i = 0; i < urls.length; i += CHUNK) ids.push(await queue(urls.slice(i, i + CHUNK)));
      const failed = await waitFor(ids);
      await app().reloadLiveTitles();
      const pagesNow = (app().allPages && app().allPages()) || [];
      const problems = pagesNow.filter(p => p.liveTitle && p.liveTitle.e).length;
      status('Live titles updated' + (problems ? ' · ' + problems + ' page' + (problems > 1 ? 's' : '') + ' couldn’t be read (hover a title to see why)' : '') + (failed ? ' · ' + failed + ' batch failed' : '') + '.');
      setTimeout(() => status(''), 12000);
    } catch (e) {
      status('Couldn’t fetch live titles: ' + e.message);
    }
    busy = false;
    if (btn) btn.disabled = false;
  }

  document.addEventListener('schema-loaded', async e => {
    const tab = (e.detail || {}).tab || '';
    const btn = $('lt-refresh'); if (btn) btn.hidden = false;
    if (asked[tab] || busy) return;
    asked[tab] = true;
    const pages = (app().allPages && app().allPages()) || [];
    const stale = pages.filter(p => !p.liveTitle || !p.liveTitle.at || Date.now() - Date.parse(p.liveTitle.at) > STALE);
    if (!stale.length) return;
    try { if (await pending()) return; } catch (er) { return; }
    refresh(stale);
  });

  document.addEventListener('click', e => {
    if (e.target.closest('#lt-refresh')) refresh((app().allPages && app().allPages()) || []);
  });
})();
