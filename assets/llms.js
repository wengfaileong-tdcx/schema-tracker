/* llms.txt tab.

   Everything lives in the connected Google Sheet (private, same access as
   the schema): "llms sites", "llms pages" (one row per page, as Markdown)
   and "llms queue". The dashboard never fetches websites itself:
     - "Check pages & update", Add, Remove and "Save to Drive" add a row to
       "llms queue"; the sheet's Apps Script (sheet-scripts/llms.gs) picks it
       up within a minute, does the work, and marks the row Done.
     - Upload converts saved staging pages in this browser and writes the
       rows straight into "llms pages".
     - llms.txt and llms-full.txt are put together here from the saved
       pages whenever they are previewed, copied or downloaded. */
(function () {
  const cfg = window.LLMS_CONFIG || {};
  if (cfg.enabled === false) return;
  const D = window.SchemaDiff, C = window.LlmsCore;
  const esc = D.esc;
  const $ = id => document.getElementById(id);
  const TAB = { sites: 'llms sites', pages: 'llms pages', queue: 'llms queue' };
  const CELL = 49000;

  const store = {
    get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };

  const S = {
    started: false, connected: false, loading: false, missing: false, error: '',
    sites: [], pages: [], queue: [], siteId: store.get('llms-site'),
    way: 'fetch', filter: 'all', open: {}, preview: null, job: null, uploads: [], pasteOpen: false
  };

  const sheet = () => window.SchemaApp && window.SchemaApp.sheet;
  const enc = s => encodeURIComponent(s);
  const now = () => new Date().toISOString();

  /* ---------- reading ---------- */

  async function load() {
    S.loading = true; S.error = ''; draw();
    try {
      const r = await sheet().api('/values:batchGet?' + [TAB.sites + '!A:J', TAB.pages + '!A:O', TAB.queue + '!A:J']
        .map(x => 'ranges=' + enc("'" + x.replace('!', "'!"))).join('&'));
      const v = r.valueRanges.map(x => (x.values || []).slice(1));
      S.missing = false;
      S.sites = v[0].filter(x => x[0] && x[2]).map(x => ({
        id: String(x[0]).trim(), name: x[1] || x[0], base: C.normUrl(x[2]), staging: (x[3] || '').trim(),
        sitemap: x[4] || '', exclude: x[6] || '', sections: C.parseSections(x[7]),
        links: !/^(n|no|false|0)$/i.test(String(x[8] || '').trim()), intro: x[9] || ''
      }));
      S.pages = v[1].map((x, i) => ({
        row: i + 2, site: x[0] || '', url: x[1] || '', title: x[2] || '', description: x[3] || '', from: x[4] || '',
        added: /^y/i.test(x[5] || ''), removed: /^y/i.test(x[6] || ''), inSitemap: x[7] || '',
        lastChanged: x[8] || '', lastChecked: x[9] || '', lastError: x[10] || '',
        markdown: (x[11] || '') + (x[12] || ''), previous: (x[13] || '') + (x[14] || ''), raw: x
      }));
      S.queue = v[2].map((x, i) => {
        let result = null;
        try { result = x[9] ? JSON.parse(x[9]) : null; } catch (e) { result = null; }
        return { row: i + 2, id: x[0], at: x[1] || '', by: x[2] || '', site: x[3] || '', action: x[4] || '', urls: x[5] || '',
          status: x[6] || '', progress: x[7] || '', finished: x[8] || '', result: result };
      });
      if (!S.sites.some(s => s.id === S.siteId)) S.siteId = S.sites[0] ? S.sites[0].id : '';
    } catch (e) {
      if (/Unable to parse range|not found/i.test(e.message)) {
        S.missing = true;
        // Show what the dashboard actually sees, so a script added to a
        // different spreadsheet (or a setup that stopped early) is obvious.
        try {
          const info = await sheet().api('?fields=properties.title,sheets.properties.title');
          S.diag = { title: (info.properties || {}).title || 'this spreadsheet', tabs: (info.sheets || []).map(x => x.properties.title), at: new Date() };
        } catch (x) { S.diag = { error: x.message, at: new Date() }; }
      }
      else S.error = 'Couldn’t read the sheet: ' + e.message;
    }
    S.loading = false; draw();
  }

  /* ---------- writing ---------- */

  const name = () => (($('lx-name') && $('lx-name').value.trim()) || store.get('llms-name') || '');

  async function enqueue(action, urls, label) {
    if (S.job) return;
    const id = 'd' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    S.job = { id: id, label: label, status: 'Sending', progress: '', since: Date.now() }; S.error = ''; draw();
    try {
      await sheet().api('/values/' + enc("'" + TAB.queue + "'!A:J") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[id, now(), name(), S.siteId, action, urls || '', 'Waiting', '', '', '']] })
      });
      S.job.status = 'Waiting'; draw();
      for (;;) {
        await new Promise(r => setTimeout(r, 4000));
        const r = await sheet().api('/values/' + enc("'" + TAB.queue + "'!A:J"));
        const row = (r.values || []).find(x => x[0] === id);
        if (!row) continue;
        S.job.status = row[6]; S.job.progress = row[7] || '';
        if (row[6] === 'Done' || row[6] === 'Failed') {
          let res = null;
          try { res = JSON.parse(row[9] || 'null'); } catch (e) { res = null; }
          if (row[6] === 'Failed') S.error = (label || 'That') + ' didn’t finish: ' + ((res && res.error) || 'unknown error');
          else if (action === 'update' || action === 'add') { S.filter = 'run'; toast(summary(res)); }
          else if (action === 'save-drive') toast('Saved both files to Drive');
          break;
        }
        draw();
      }
    } catch (e) {
      S.error = 'Couldn’t reach the sheet: ' + e.message;
    }
    S.job = null;
    await load();
  }

  function summary(res) {
    const c = (res && res.counts) || {};
    const bits = [];
    if (c.changed) bits.push(c.changed + ' changed');
    if (c.new) bits.push(c.new + ' new');
    if (c.failed) bits.push(c.failed + ' couldn’t be fetched');
    return 'Done: ' + (bits.length ? bits.join(', ') : 'no changes');
  }

  const split = s => [s.slice(0, CELL), s.slice(CELL, CELL * 2)];

  async function saveUploads() {
    const items = S.uploads.filter(u => u.include && u.url && u.state !== 'same' && !u.error);
    if (!items.length) return;
    S.job = { label: 'Save uploads', status: 'Saving', progress: '' }; S.error = ''; draw();
    try {
      // Re-read the URL column so row numbers are current.
      const r = await sheet().api('/values/' + enc("'" + TAB.pages + "'!A:O"));
      const rows = (r.values || []);
      const stamp = now(), updates = [], appends = [], results = [];
      items.forEach(u => {
        const i = rows.findIndex((x, k) => k > 0 && x[0] === S.siteId && x[1] === u.url);
        const old = i > 0 ? rows[i] : null;
        const prev = old ? (old[11] || '') + (old[12] || '') : '';
        const md = split(u.md), pv = split(prev);
        const row = [S.siteId, u.url, u.title, u.description, 'staging upload', old ? old[5] || '' : 'yes', '', old ? old[7] || '' : '',
          stamp, stamp, u.md.length > CELL * 2 ? 'Text cut at ' + CELL * 2 + ' characters' : '', md[0], md[1], pv[0], pv[1]];
        if (old) updates.push({ range: "'" + TAB.pages + "'!A" + (i + 1) + ':O' + (i + 1), values: [row] });
        else appends.push(row);
        results.push({ u: u.url, t: u.title, s: prev ? (prev === u.md ? 'same' : 'changed') : 'new', up: 1 });
      });
      if (updates.length) await sheet().api('/values:batchUpdate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) });
      if (appends.length) await sheet().api('/values/' + enc("'" + TAB.pages + "'!A:O") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: appends }) });
      const counts = {};
      results.forEach(x => { counts[x.s] = (counts[x.s] || 0) + 1; });
      await sheet().api('/values/' + enc("'" + TAB.queue + "'!A:J") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [['u' + Date.now().toString(36), stamp, name(), S.siteId, 'upload', results.map(x => x.u).join(' '), 'Done', '', stamp,
          JSON.stringify({ action: 'upload', scope: 'selected', counts: counts, results: results })]] })
      });
      S.uploads = []; S.filter = 'run';
      toast('Saved ' + results.length + ' page' + (results.length > 1 ? 's' : '') + ' to the sheet');
    } catch (e) {
      S.error = 'Couldn’t save to the sheet: ' + e.message + '. Nothing was lost; try Save again.';
    }
    S.job = null;
    await load();
  }

  /* ---------- uploads (converted here, in the browser) ---------- */

  function addUpload(fileName, html, typedUrl) {
    const st = site();
    const stated = C.statedUrl(html);
    const url = typedUrl ? C.toLive(typedUrl, st.base) : (stated ? C.toLive(stated, st.base) : '');
    const x = C.toMarkdown(html, url || st.base);
    const u = { key: Math.random().toString(36).slice(2), file: fileName, stated: stated, url: url || '', include: true,
      title: C.shortTitle(x.title, st.name) || x.h1 || '', description: x.description || '', md: x.md };
    if (!x.md || x.md.length < 40) u.error = 'No page text found in this file. Save the page again with “Webpage, HTML only”, or paste its source.';
    S.uploads.push(u);
    rate(u);
  }
  function rate(u) {
    const p = u.url && S.pages.find(x => x.site === S.siteId && x.url === u.url);
    u.state = !u.url ? 'nourl' : !p || !p.markdown ? 'new' : p.markdown === u.md ? 'same' : 'changed';
  }
  async function readFiles(list) {
    for (const f of Array.from(list)) {
      if (!/\.(html?|xhtml|txt)$/i.test(f.name) && !/html/.test(f.type)) { S.error = f.name + ' isn’t an HTML file. Save the page as “Webpage, HTML only”.'; continue; }
      addUpload(f.name, await f.text());
    }
    draw();
  }

  /* ---------- helpers ---------- */

  const site = () => S.sites.find(s => s.id === S.siteId) || {};
  const sitePages = () => S.pages.filter(p => p.site === S.siteId);
  const when = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  const pathLabel = u => { const p = C.pathOf(u); return p === '/' ? '/ (home)' : p; };
  const kb = s => !s ? '0 KB' : s.length < 1024 ? s.length + ' B' : (s.length / 1024).toFixed(s.length < 10240 ? 1 : 0) + ' KB';
  const urlsIn = s => (s || '').split(/[\s,]+/).map(x => x.trim()).filter(x => /^https?:\/\//i.test(x));
  const jobsFor = (pred) => S.queue.filter(q => q.site === S.siteId && q.status === 'Done' && pred(q)).sort((a, b) => (b.finished || b.at).localeCompare(a.finished || a.at));
  const lastUpdate = () => jobsFor(q => /^(update|add|upload)$/.test(q.action) && q.result)[0];
  const lastWeekly = () => jobsFor(q => q.action === 'check' && q.result)[0];
  const lastDrive = () => jobsFor(q => q.action === 'save-drive' && q.result)[0];
  const livePages = () => sitePages().filter(p => !p.removed && p.markdown);
  const files = () => { const st = site(), ps = livePages(); return { 'llms.txt': C.buildLlmsTxt(st, ps), 'llms-full.txt': C.buildLlmsFull(st, ps) }; };

  const PILL = { changed: ['Changed', 'lx-p-chg'], new: ['New', 'lx-p-new'], same: ['No change', 'lx-p-same'], failed: ['Couldn’t fetch', 'lx-p-fail'],
    removed: ['Removed', 'lx-p-same'], nourl: ['Needs address', 'lx-p-fail'] };
  const pill = st => { const p = PILL[st] || [st, 'lx-p-same']; return '<span class="lx-pill ' + p[1] + '">' + p[0] + '</span>'; };

  function toast(text) {
    const t = $('toast');
    if (!t) return;
    t.textContent = text; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => toast('Copied to clipboard'), () => toast('Couldn’t copy. Your browser blocked it.'));
  }
  function download(fileName, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = fileName; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------- drawing ---------- */

  function draw() {
    const host = $('llms');
    if (!host || host.hidden) return;
    const keep = {};
    if (!S.clearInputs) ['lx-urls', 'lx-add', 'lx-paste-url', 'lx-paste-src'].forEach(id => { if ($(id)) keep[id] = $(id).value; });
    S.clearInputs = false;
    host.innerHTML = body();
    Object.keys(keep).forEach(id => { if ($(id)) $(id).value = keep[id]; });
  }

  function body() {
    if (!S.connected) {
      return '<div class="empty"><p>The llms.txt pages and files are kept in the private Google Sheet.</p>' +
        '<button type="button" class="primary" data-lx="connect">Connect Google Sheet</button></div>';
    }
    if (S.loading && !S.sites.length) return '<div class="empty">Loading from the sheet…</div>';
    if (S.missing) {
      return '<div class="lx-card"><h3>One-time setup in the sheet</h3><ol class="lx-steps">' +
        '<li>Open the sheet → <b>Extensions → Apps Script</b>.</li>' +
        '<li>Add a script file named <b>llms</b> and paste the whole of <a href="https://github.com/' + esc(cfg.repo || 'wengfaileong-tdcx/schema-tracker') + '/blob/main/sheet-scripts/llms.gs" target="_blank" rel="noopener">sheet-scripts/llms.gs</a>. Keep your existing script as it is.</li>' +
        '<li>Save, choose <b>llmsSetup</b> at the top, press <b>Run</b>, and allow the permissions.</li>' +
        '<li>Come back here and press <b>Reload</b>.</li></ol>' + drawDiag() +
        '<button type="button" class="primary" data-lx="reload">Reload</button></div>' + drawError();
    }
    if (!S.sites.length) return drawError() + '<div class="empty">No sites in the “llms sites” tab yet. Add one row per website there, then Reload.</div>';
    return [drawSites(), drawError(), drawFiles(), drawGet(), drawWeekly(), drawStats(), drawList(), drawNotes()].join('');
  }

  function drawDiag() {
    const d = S.diag;
    if (!d) return '';
    const t = d.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (d.error) return '<p class="lx-diag">Checked at ' + t + ': couldn’t list the tabs (' + esc(d.error) + ').</p>';
    const need = [TAB.sites, TAB.pages, TAB.queue], miss = need.filter(n => d.tabs.indexOf(n) < 0);
    return '<div class="lx-diag"><b>Checked at ' + t + '</b> in the spreadsheet “' + esc(d.title) + '” (<a href="' + esc(sheet().url) + '" target="_blank" rel="noopener">open it</a>).<br>' +
      'Tabs found: ' + esc(d.tabs.join(', ')) + '.<br>Still missing: <b>' + esc(miss.join(', ')) + '</b>.<br>' +
      'If you added the script to a different spreadsheet, add it to this one instead. If llmsSetup showed an error when you ran it, send me that message.</div>';
  }

  function drawError() { return S.error ? '<div class="lx-err" role="alert">' + esc(S.error) + '</div>' : ''; }

  function drawSites() {
    return '<div class="lx-sites" role="group" aria-label="Site">' + S.sites.map(s =>
      '<button type="button" class="lx-sitebtn" data-site="' + esc(s.id) + '" aria-pressed="' + (s.id === S.siteId) + '"' + (S.job ? ' disabled' : '') + '>' +
      '<b>' + esc(s.name) + '</b><small>' + esc(C.host(s.base)) + ' · ' + S.pages.filter(p => p.site === s.id && !p.removed && p.markdown).length + ' pages</small></button>').join('') +
      '<a class="lx-sheetlink" href="' + esc(sheet().url) + '" target="_blank" rel="noopener">Edit sites &amp; intros in the sheet</a></div>';
  }

  function drawFiles() {
    const f = files(), st = site(), d = lastDrive();
    const row = (fname, desc) => {
      const shown = S.preview === fname;
      return '<div class="lx-file"><div class="lx-file-top"><div><b>' + fname + '</b> <span class="lx-size">' + kb(f[fname]) + '</span>' +
        '<div class="lx-file-d">' + desc + '</div></div><div class="lx-row">' +
        '<button type="button" class="mini" data-lx="preview" data-file="' + fname + '" aria-expanded="' + shown + '">' + (shown ? 'Hide' : 'Preview') + '</button>' +
        '<button type="button" class="mini" data-lx="copy" data-file="' + fname + '">Copy</button>' +
        '<button type="button" class="mini primary" data-lx="download" data-file="' + fname + '">Download</button></div></div>' +
        (shown ? '<pre class="lx-pre lx-file-pre">' + esc(f[fname]) + '</pre>' : '') + '</div>';
    };
    const driveLine = d && d.result && d.result.files
      ? 'Last saved to Drive ' + esc(when(d.finished)) + (d.by ? ' by ' + esc(d.by) : '') + ': ' + d.result.files.map(x => '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a>').join(', ')
      : 'Not saved to Drive yet.';
    return '<div class="lx-card"><div class="lx-files-h"><div><h3>Files for the developer</h3>' +
      '<p class="lx-hint">Put together from the ' + livePages().length + ' saved pages of ' + esc(st.name) + '. Send both to the developer to upload to the site root.</p></div>' +
      '<button type="button" data-lx="drive"' + (S.job || !livePages().length ? ' disabled' : '') + '>Save both to Drive</button></div>' +
      row('llms.txt', (st.intro ? 'Intro from the sheet' : 'Site name and summary') + (st.links ? ' + a linked list of every page' : '')) +
      row('llms-full.txt', 'The full text of every page, one after another') +
      '<p class="lx-hint lx-drive">' + driveLine + '</p></div>';
  }

  function drawJob() {
    const j = S.job;
    if (!j) return '';
    let text = j.label + ': ';
    if (j.status === 'Sending') text += 'sending to the sheet…';
    else if (j.status === 'Waiting') text += Date.now() - (j.since || Date.now()) > 3 * 60000
      ? 'still waiting. The sheet script may not be running; check that llmsSetup was run.'
      : 'waiting for the sheet script to pick it up (up to a minute)…';
    else if (j.status === 'Running') text += 'fetching pages' + (j.progress ? ' (' + j.progress + ')' : '') + '…';
    else if (j.status === 'Saving') text += 'saving to the sheet…';
    else text += j.status;
    return '<span class="lx-spin" aria-hidden="true"></span><span role="status">' + esc(text) + '</span>';
  }

  function drawGet() {
    const st = site(), b = !!S.job, lu = lastUpdate();
    const tabs = '<div class="lx-ways" role="tablist" aria-label="How to get page text">' +
      '<button type="button" role="tab" data-way="fetch" aria-selected="' + (S.way === 'fetch') + '">Fetch from the live site</button>' +
      '<button type="button" role="tab" data-way="upload" aria-selected="' + (S.way === 'upload') + '">Upload pages (staging)</button></div>';
    const status = b ? drawJob() : 'Last update: ' + (lu ? esc(when(lu.finished)) + (lu.by ? ' by ' + esc(lu.by) : '') : 'none yet');
    const nameField = '<div class="lx-name"><label for="lx-name">Your name</label><input type="text" id="lx-name" value="' + esc(store.get('llms-name')) + '" placeholder="Shown in the sheet" autocomplete="name"></div>';
    let pane;
    if (S.way === 'fetch') {
      pane = '<label for="lx-urls">Pages the developer changed <span class="lx-opt">(optional, one per line)</span></label>' +
        '<textarea id="lx-urls" rows="3" placeholder="' + esc(st.base || 'https://') + '/page&#10;Leave empty to check every page, plus new pages in sitemap.xml"' + (b ? ' disabled' : '') + '></textarea>' +
        '<div class="lx-row lx-actions"><button type="button" class="primary" data-lx="update"' + (b ? ' disabled' : '') + '>Check pages &amp; update</button>' + nameField +
        '<span class="lx-last">' + status + '</span></div>' +
        '<p class="lx-hint">Google fetches the pages from the sheet’s script. Only pages whose text changed are saved. Pages the site blocks show as “Couldn’t fetch”; upload those instead.</p>';
    } else {
      const ups = S.uploads;
      const saveable = ups.filter(u => u.include && !u.error && u.state !== 'same' && (u.url || u.state === 'nourl')).length;
      pane = '<label class="lx-drop" for="lx-file" tabindex="0"><b>Choose saved pages, or drop them here</b><span>.html files saved from ' + esc(st.staging || 'the staging site') + '. Several at once is fine.</span></label>' +
        '<input type="file" id="lx-file" accept=".html,.htm,text/html" multiple class="sr-only"' + (b ? ' disabled' : '') + '>' +
        '<ol class="lx-howto"><li>Open the page on staging in your own browser.</li>' +
        '<li>Save it with Cmd+S / Ctrl+S as “Webpage, HTML only”, or press <b>Paste source</b> and paste what Cmd+Option+U / Ctrl+U shows.</li>' +
        '<li>Check each page’s live address below, then save. Nothing is saved until you press Save.</li></ol>' +
        '<div class="lx-row"><button type="button" class="mini" data-lx="paste-open"' + (b ? ' disabled' : '') + '>Paste source</button></div>' +
        (S.pasteOpen ? '<div class="lx-paste"><label for="lx-paste-url">Live address of this page</label><input type="text" id="lx-paste-url" placeholder="' + esc(st.base) + '/page">' +
          '<label for="lx-paste-src">Page source</label><textarea id="lx-paste-src" rows="5" placeholder="&lt;!DOCTYPE html&gt;…"></textarea>' +
          '<div class="lx-row"><button type="button" class="mini primary" data-lx="paste-add">Add</button><button type="button" class="mini" data-lx="paste-cancel">Cancel</button></div></div>' : '') +
        (ups.length ? '<div class="lx-ups">' + ups.map(u =>
          '<div class="lx-up"><div class="lx-up-f"><input type="checkbox" id="inc-' + u.key + '" data-inc="' + u.key + '"' + (u.include ? ' checked' : '') + (u.error ? ' disabled' : '') + '>' +
          '<label for="inc-' + u.key + '">' + esc(u.file) + '</label></div>' +
          '<div class="lx-up-u"><label for="url-' + u.key + '" class="sr-only">Live address for ' + esc(u.file) + '</label><input type="text" id="url-' + u.key + '" data-url-for="' + u.key + '" value="' + esc(u.url) + '" placeholder="' + esc(st.base) + '/page"></div>' +
          '<div class="lx-up-s">' + (u.error ? '<span class="lx-rerr">' + esc(u.error) + '</span>' : pill(u.state)) + '</div></div>').join('') + '</div>' +
          '<div class="lx-row lx-actions"><button type="button" class="primary" data-lx="save-up"' + (b || !saveable ? ' disabled' : '') + '>Save ' + saveable + ' page' + (saveable === 1 ? '' : 's') + ' to the sheet</button>' + nameField +
          '<button type="button" class="mini" data-lx="clear-up">Clear</button><span class="lx-last">' + (b ? drawJob() : (ups.some(u => u.state === 'same') ? 'Pages with no change are skipped.' : '')) + '</span></div>' : '');
    }
    return '<div class="lx-card">' + tabs + pane + '</div>';
  }

  function drawWeekly() {
    const w = lastWeekly(), lu = lastUpdate();
    if (!w || (lu && (lu.finished || '') > (w.finished || ''))) return '';
    const items = (w.result.results || []).filter(r => r.s === 'changed' || r.s === 'new');
    if (!items.length) return '';
    return '<div class="lx-weekly"><div><b>Weekly check, ' + esc(when(w.finished)) + ':</b> ' + items.length + ' page' + (items.length > 1 ? 's' : '') +
      ' changed on the live site since the last update. Nothing was saved yet.</div>' +
      '<button type="button" class="mini" data-lx="use-weekly"' + (S.job ? ' disabled' : '') + '>Update these ' + items.length + ' pages</button></div>';
  }

  function runResults() { const lu = lastUpdate(); return (lu && lu.result && lu.result.results) || []; }

  function drawStats() {
    const res = runResults(), c = k => res.filter(r => r.s === k).length;
    const tracked = sitePages().filter(p => !p.removed).length;
    const tile = (k, n, l) => '<button type="button" class="lx-tile' + (S.filter === k ? ' on' : '') + '" data-lx-filter="' + k + '" aria-pressed="' + (S.filter === k) + '"><b>' + n + '</b><span>' + l + '</span></button>';
    return '<div class="lx-tiles">' + tile('all', tracked, 'Pages tracked') + tile('changed', c('changed'), 'Changed in last update') +
      tile('new', c('new'), 'New in last update') + tile('failed', c('failed'), 'Couldn’t fetch in last update') + '</div>';
  }

  function drawList() {
    const lu = lastUpdate(), res = new Map(runResults().map(r => [r.u, r]));
    const all = sitePages();
    let f = S.filter === 'run' ? 'all' : S.filter;
    const rows = f === 'all'
      ? all.filter(p => !p.removed).map(p => ({ p: p, r: res.get(p.url) }))
      : runResults().filter(r => r.s === f).map(r => ({ p: all.find(p => p.url === r.u) || { url: r.u, title: r.t }, r: r }));
    const head = f === 'all' ? 'All pages' : PILL[f][0] + ' in the last update' + (lu ? ' (' + esc(when(lu.finished)) + ')' : '');
    const removed = all.filter(p => p.removed);
    return '<div class="lx-card"><div class="lx-list-h"><h3>' + head + '</h3>' +
      '<div class="lx-add"><label for="lx-add" class="sr-only">Add a page</label><input type="text" id="lx-add" placeholder="Add a page not in the sitemap: https://…"' + (S.job ? ' disabled' : '') + '>' +
      '<button type="button" class="mini" data-lx="add"' + (S.job ? ' disabled' : '') + '>Add page</button></div></div>' +
      '<div class="lx-list">' + (rows.length ? rows.map(drawRow).join('') : '<div class="lx-none">' + (all.length ? 'None.' : 'No pages yet. Press <b>Check pages &amp; update</b> with the box empty to fetch the whole site.') + '</div>') + '</div>' +
      (removed.length && f === 'all' ? '<details class="lx-excl"><summary>' + removed.length + ' removed page' + (removed.length > 1 ? 's' : '') + ' (left out of both files)</summary>' +
        removed.map(p => '<div class="lx-xrow"><span>' + esc(pathLabel(p.url)) + '</span><button type="button" class="mini" data-lx="readd" data-url="' + esc(p.url) + '"' + (S.job ? ' disabled' : '') + '>Track again</button></div>').join('') + '</details>' : '') +
      '</div>';
  }

  function drawRow(x) {
    const p = x.p, r = x.r, st = r ? r.s : null;
    const canOpen = !!(p.markdown || p.previous);
    const open = !!S.open[p.url];
    const meta = [];
    if (p.lastChanged) meta.push('Text last changed ' + when(p.lastChanged));
    if (p.from === 'staging upload') meta.push('From a staging upload');
    if (p.inSitemap === 'no') meta.push('Not in sitemap.xml');
    if (p.added) meta.push('Added by hand');
    const err = r && r.e ? r.e : (!r && p.lastError ? 'Last try: ' + p.lastError : '');
    let detail = '';
    if (open && canOpen) {
      if (p.previous && p.previous !== p.markdown) {
        const d = D.compare(p.previous, p.markdown, { text: true, full: false, context: 3, labels: { left: 'Before', right: 'Now' } });
        detail = '<div class="lx-sub">Last change</div>' + (d.error ? '<div class="lx-rerr">' + esc(d.error) + '</div>' : '<div class="lx-diff">' + d.html + '</div>');
      } else detail = '<pre class="lx-pre">' + esc(p.markdown || '(no text saved)') + '</pre>';
    }
    return '<div class="lx-r' + (open ? ' open' : '') + '"><div class="lx-r-top">' +
      (canOpen ? '<button type="button" class="lx-tog" data-lx="toggle" data-url="' + esc(p.url) + '" aria-expanded="' + open + '">' : '<div class="lx-tog lx-tog-static">') +
      '<span class="lx-path">' + esc(pathLabel(p.url)) + '</span><span class="lx-title">' + esc(p.title || '') + '</span>' + (canOpen ? '</button>' : '</div>') +
      '<div class="lx-r-side">' + (st ? pill(st) : '') +
      '<a class="lx-ext" href="' + esc(p.url) + '" target="_blank" rel="noopener" aria-label="Open ' + esc(pathLabel(p.url)) + ' on the site">↗</a>' +
      (p.removed ? '' : '<button type="button" class="lx-x" data-lx="remove" data-url="' + esc(p.url) + '" aria-label="Stop tracking ' + esc(pathLabel(p.url)) + '"' + (S.job ? ' disabled' : '') + '>Remove</button>') +
      '</div></div>' + (meta.length ? '<div class="lx-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
      (err ? '<div class="lx-rerr">' + esc(err) + '</div>' : '') + detail + '</div>';
  }

  function drawNotes() {
    return '<div class="lx-notes"><b>Good to know</b><ul>' +
      '<li>Everything here is stored in the private Google Sheet and the Drive folder. Only people with access to them can see it.</li>' +
      '<li>The intro at the top of llms.txt is the “Intro” cell for the site in the “llms sites” tab.</li>' +
      '<li>Fetching reads each page’s HTML. Text that only appears after JavaScript runs can be missing; upload the page saved from your browser instead.</li>' +
      '<li>Sites that block automatic fetching (bot protection) are not bypassed. Use Upload for them.</li>' +
      '<li>A check runs every Monday at 9am. It only compares and shows a reminder here; it never changes saved pages.</li></ul></div>';
  }

  /* ---------- events ---------- */

  async function onClick(e) {
    const t = e.target.closest('[data-lx],[data-lx-filter],[data-site],[data-way]');
    if (!t || !$('llms').contains(t) || t.disabled) return;
    if (t.dataset.site) { S.siteId = t.dataset.site; store.set('llms-site', S.siteId); S.filter = 'all'; S.open = {}; S.uploads = []; S.preview = null; S.clearInputs = true; draw(); return; }
    if (t.dataset.way) { S.way = t.dataset.way; draw(); return; }
    if (t.dataset.lxFilter) { S.filter = t.dataset.lxFilter; draw(); return; }
    const act = t.dataset.lx, url = t.dataset.url, file = t.dataset.file;
    if (act === 'connect') { const b = $('sheet-connect'); if (b) b.click(); }
    else if (act === 'reload') load();
    else if (act === 'update') {
      const raw = $('lx-urls').value, urls = urlsIn(raw);
      if (raw.trim() && !urls.length) { S.error = 'Those don’t look like full page addresses. Paste them starting with https://'; draw(); return; }
      enqueue('update', urls.join(' '), urls.length ? 'Update ' + urls.length + ' page' + (urls.length > 1 ? 's' : '') : 'Update all pages');
    }
    else if (act === 'use-weekly') {
      const urls = (lastWeekly().result.results || []).filter(r => r.s === 'changed' || r.s === 'new').map(r => r.u);
      S.way = 'fetch'; draw(); $('lx-urls').value = urls.join('\n');
      enqueue('update', urls.join(' '), 'Update ' + urls.length + ' pages');
    }
    else if (act === 'add') {
      const urls = urlsIn($('lx-add').value);
      if (!urls.length) { S.error = 'Paste the full address of the page, starting with https://'; draw(); return; }
      $('lx-add').value = '';
      enqueue('add', urls.join(' '), 'Add page');
    }
    else if (act === 'remove') {
      if (!window.confirm('Stop tracking ' + pathLabel(url) + '? It will be left out of llms.txt and llms-full.txt, and won’t be added back from the sitemap.')) return;
      enqueue('remove', url, 'Remove page');
    }
    else if (act === 'readd') enqueue('add', url, 'Track again');
    else if (act === 'drive') enqueue('save-drive', '', 'Save to Drive');
    else if (act === 'toggle') { S.open[url] = !S.open[url]; draw(); }
    else if (act === 'preview') { S.preview = S.preview === file ? null : file; draw(); }
    else if (act === 'copy') copy(files()[file]);
    else if (act === 'download') {
      if (!livePages().length) { toast('No saved pages yet'); return; }
      download(file, files()[file]);
    }
    else if (act === 'paste-open') { S.pasteOpen = true; draw(); $('lx-paste-url').focus(); }
    else if (act === 'paste-cancel') { S.pasteOpen = false; draw(); }
    else if (act === 'paste-add') {
      const src = $('lx-paste-src').value, u = $('lx-paste-url').value.trim();
      if (!src.trim()) { $('lx-paste-src').focus(); return; }
      addUpload(u ? C.pathOf(C.normUrl(u) || u) : 'Pasted source', src, u);
      $('lx-paste-src').value = ''; $('lx-paste-url').value = ''; S.pasteOpen = false; draw();
    }
    else if (act === 'save-up') {
      const missing = S.uploads.filter(u => u.include && !u.error && !u.url);
      if (missing.length) { S.error = 'Fill in the live address for ' + missing.map(u => u.file).join(', ') + ', or untick it.'; draw(); return; }
      saveUploads();
    }
    else if (act === 'clear-up') { S.uploads = []; draw(); }
  }

  function onChange(e) {
    const t = e.target;
    if (t.id === 'lx-file') { readFiles(t.files); t.value = ''; return; }
    if (t.id === 'lx-name') { store.set('llms-name', t.value.trim()); return; }
    if (t.dataset.inc) { const u = S.uploads.find(x => x.key === t.dataset.inc); if (u) u.include = t.checked; draw(); return; }
    if (t.dataset.urlFor) {
      const u = S.uploads.find(x => x.key === t.dataset.urlFor);
      if (!u) return;
      const st = site(), v = t.value.trim();
      if (v && !C.normUrl(v)) { S.error = 'Use a full address starting with https://'; draw(); return; }
      u.url = v ? C.toLive(v, st.base) : '';
      rate(u); draw();
    }
  }

  /* ---------- tabs ---------- */

  const SCHEMA_PARTS = ['hero', 'recent', 'fr', 'list', 'tools'];
  function showTab(nameTab) {
    const llms = nameTab === 'llms';
    document.querySelectorAll('.tabs [role="tab"]').forEach(b => {
      const on = b.dataset.tab === nameTab;
      b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1;
    });
    SCHEMA_PARTS.forEach(id => { const n = $(id); if (n) n.classList.toggle('tab-off', llms); });
    document.querySelector('.topbar').classList.toggle('tab-off', llms);
    $('llms').hidden = !llms;
    if (llms && S.connected && !S.started) { S.started = true; load(); }
    draw();
  }

  function init() {
    const tabs = document.querySelector('.tabs');
    if (!tabs || !C) return;
    tabs.hidden = false;
    tabs.addEventListener('click', e => {
      const b = e.target.closest('[role="tab"]');
      if (!b) return;
      history.replaceState(null, '', b.dataset.tab === 'llms' ? '#llms' : location.pathname + location.search);
      showTab(b.dataset.tab);
    });
    tabs.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const all = [...tabs.querySelectorAll('[role="tab"]')];
      const n = all[(all.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      n.focus(); n.click();
    });
    const host = $('llms');
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === 'lx-add') { e.preventDefault(); host.querySelector('[data-lx="add"]').click(); }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('lx-drop')) { e.preventDefault(); $('lx-file').click(); }
    });
    host.addEventListener('dragover', e => { if (e.target.closest('.lx-drop')) { e.preventDefault(); e.target.closest('.lx-drop').classList.add('over'); } });
    host.addEventListener('dragleave', e => { const d = e.target.closest('.lx-drop'); if (d) d.classList.remove('over'); });
    host.addEventListener('drop', e => {
      const d = e.target.closest('.lx-drop');
      if (!d) return;
      e.preventDefault(); d.classList.remove('over');
      readFiles(e.dataTransfer.files);
    });
    document.addEventListener('sheet-connected', () => {
      S.connected = true; S.started = !$('llms').hidden;
      if (S.started) load();
    });
    if (location.hash === '#llms') showTab('llms');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
