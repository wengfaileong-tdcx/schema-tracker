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
  const TAB = { sites: 'llms sites', pages: 'llms pages', queue: 'llms queue', files: 'llms files', history: 'llms page history' };
  const FILE_COLS = ['Site ID', 'File', 'Version', 'Kind', 'Saved at', 'Saved by', 'Part', 'Text'];
  const CM_TAB = (window.SHEET_CONFIG || {}).lineCommentsTab || '';
  const CELL = 49000;

  const store = {
    get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };

  const S = {
    started: false, connected: false, loading: false, missing: false, error: '',
    sites: [], pages: [], queue: [], siteId: store.get('llms-site'),
    way: 'fetch', filter: 'all', open: {}, preview: null, job: null, uploads: [], pasteOpen: false,
    versions: [], filesTab: false, comments: {}, editing: null, choices: {}, pageEdit: null,
    exports: [], hist: [], histText: {}, histPick: {}, histTab: 'updates', histOpen: {}, histMore: 0, fileCmp: {}
  };

  const sheet = () => window.SchemaApp && window.SchemaApp.sheet;
  const enc = s => encodeURIComponent(s);
  const now = () => new Date().toISOString();

  /* ---------- reading ---------- */

  async function load() {
    S.loading = true; S.error = ''; draw();
    try {
      const r = await sheet().api('/values:batchGet?' + [TAB.sites + '!A:J', TAB.pages + '!A:Q', TAB.queue + '!A:J']
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
        markdown: (x[11] || '') + (x[12] || ''), previous: (x[13] || '') + (x[14] || ''), editBase: (x[15] || '') + (x[16] || ''), raw: x
      }));
      S.queue = v[2].map((x, i) => {
        let result = null;
        try { result = x[9] ? JSON.parse(x[9]) : null; } catch (e) { result = null; }
        return { row: i + 2, id: x[0], at: x[1] || '', by: x[2] || '', site: x[3] || '', action: x[4] || '', urls: x[5] || '',
          status: x[6] || '', progress: x[7] || '', finished: x[8] || '', result: result };
      });
      if (!S.sites.some(s => s.id === S.siteId)) S.siteId = S.sites[0] ? S.sites[0].id : '';
      await loadExtras();
      await loadHistory();
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


  // "llms page history": older text of each page. Only the small columns are
  // read here; a version's text is fetched when someone compares it.
  async function loadHistory() {
    try {
      const r = await sheet().api('/values/' + enc("'" + TAB.history + "'!A:E"));
      S.hist = (r.values || []).slice(1).map((x, i) => ({ row: i + 2, site: x[0] || '', url: x[1] || '', since: x[2] || '', at: x[3] || '', from: x[4] || '' }))
        .filter(h => h.url);
    } catch (e) { S.hist = []; }
  }
  async function histTexts(list) {
    const need = list.filter(h => S.histText[h.site + '|' + h.url + '|' + h.at] == null);
    if (!need.length) return;
    const r = await sheet().api('/values:batchGet?' + need.map(h => 'ranges=' + enc("'" + TAB.history + "'!A" + h.row + ':G' + h.row)).join('&'));
    r.valueRanges.forEach((v, i) => {
      const x = (v.values || [])[0] || [], h = need[i];
      // Rows can move when old ones are pruned: only trust the row if it is still the same version.
      if (x[0] !== h.site || x[1] !== h.url || x[3] !== h.at) throw new Error('the history changed in the sheet. Press Reload.');
      S.histText[h.site + '|' + h.url + '|' + h.at] = (x[5] || '') + (x[6] || '');
    });
  }
  // Uploads and hand edits replace a page's text from here, so they keep the old text too.
  async function keepHistory(rows) {
    if (!rows.length) return;
    await sheet().api('/values/' + enc("'" + TAB.history + "'!A:G") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: rows }) }).catch(() => { /* no history tab yet: rerun llmsSetup */ });
  }

  // Saved versions of the two files ("llms files" tab, created on first save)
  // and line comments on them (the dashboard's existing "Line Comments" tab).
  async function loadExtras() {
    try {
      const r = await sheet().api('/values/' + enc("'" + TAB.files + "'!A:H"));
      S.filesTab = true;
      const by = {};
      (r.values || []).slice(1).forEach(x => {
        const k = x[0] + '|' + x[1] + '|' + x[2];
        const v = by[k] || (by[k] = { site: x[0], file: x[1], version: x[2], savedAt: x[4] || '', by: x[5] || '', parts: {} });
        (v.parts[x[3]] = v.parts[x[3]] || []).push([+x[6] || 0, x[7] || '']);
      });
      S.versions = Object.values(by).map(v => {
        const join = kind => (v.parts[kind] || []).sort((a, b) => a[0] - b[0]).map(p => p[1]).join('');
        return { site: v.site, file: v.file, version: v.version, savedAt: v.savedAt, by: v.by,
          reset: !!v.parts.reset, export: !!v.parts.export && !v.parts.mine, mine: join('mine'), base: join('base'), text: join('export') };
      }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      S.exports = S.versions.filter(v => v.export);
      S.versions = S.versions.filter(v => !v.export);
    } catch (e) { S.filesTab = false; S.versions = []; }
    S.comments = {};
    if (!CM_TAB) return;
    try {
      const r = await sheet().api('/values/' + enc(CM_TAB));
      const rows = r.values || [], head = (rows[0] || []).map(x => String(x || '').trim().toLowerCase());
      const ix = n => head.indexOf(n);
      rows.slice(1).forEach(x => {
        const url = (x[ix('url')] || '').trim(), d = (x[ix('diffid')] || '').trim(), k = (x[ix('linekey')] || '').trim(), text = (x[ix('comment')] || '').trim();
        if (!/\/llms(-full)?\.txt$/.test(url) || !d || !k || !text) return;
        const res = ix('resolved') > -1 ? String(x[ix('resolved')] || '').trim().toLowerCase() : '';
        addComment(url, d, k, { name: (x[ix('name')] || '').trim(), text: text, context: (x[ix('context')] || '').trim(),
          ts: (x[ix('timestamp')] || '').trim(), resolved: !!res && res !== 'false' && res !== 'no' && res !== '0' });
      });
    } catch (e) { /* no comments tab yet */ }
  }
  function addComment(url, diffId, key, c) {
    const u = S.comments[url] || (S.comments[url] = {});
    const d = u[diffId] || (u[diffId] = {});
    (d[key] = d[key] || []).push(c);
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
      const r = await sheet().api('/values/' + enc("'" + TAB.pages + "'!A:Q"));
      const rows = (r.values || []);
      const stamp = now(), updates = [], appends = [], results = [], hist = [];
      items.forEach(u => {
        const i = rows.findIndex((x, k) => k > 0 && x[0] === S.siteId && x[1] === u.url);
        const old = i > 0 ? rows[i] : null;
        const prev = old ? (old[11] || '') + (old[12] || '') : '';
        const base = old ? (old[15] || '') + (old[16] || '') : '';
        // A page you edited by hand keeps your edits; the upload's changes are merged in.
        const m = base ? C.mergePage(base, prev, u.md) : { md: u.md, conflicts: 0 };
        const md = split(m.md), pv = split(prev), eb = base ? split(u.md) : ['', ''];
        const note = m.md.length > CELL * 2 ? 'Text cut at ' + CELL * 2 + ' characters' : m.conflicts ? C.reviewNote(m.conflicts) : '';
        const row = [S.siteId, u.url, u.title, u.description, base ? 'staging upload + your edits' : 'staging upload', old ? old[5] || '' : 'yes', '', old ? old[7] || '' : '',
          stamp, stamp, note, md[0], md[1], pv[0], pv[1], eb[0], eb[1]];
        if (old) updates.push({ range: "'" + TAB.pages + "'!A" + (i + 1) + ':Q' + (i + 1), values: [row] });
        if (old && prev && prev !== m.md) hist.push([S.siteId, u.url, old[8] || '', stamp, old[4] || '', pv[0], pv[1]]);
        else appends.push(row);
        results.push({ u: u.url, t: u.title, s: prev ? ((base || prev) === u.md ? 'same' : 'changed') : 'new', up: 1 });
      });
      if (updates.length) await sheet().api('/values:batchUpdate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) });
      await keepHistory(hist);
      if (appends.length) await sheet().api('/values/' + enc("'" + TAB.pages + "'!A:Q") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: appends }) });
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


  // Your own text for one page. "Edited from" keeps the page text your
  // edit started from, so later fetches can merge into your text.
  async function savePageText(url, text, undo) {
    S.job = { label: undo ? 'Undo my edits' : 'Save page text', status: 'Saving', progress: '' }; S.error = ''; draw();
    try {
      const r = await sheet().api('/values/' + enc("'" + TAB.pages + "'!A:Q"));
      const rows = r.values || [];
      const i = rows.findIndex((x, k) => k > 0 && x[0] === S.siteId && x[1] === url);
      if (i < 1) throw new Error('this page isn’t in the sheet any more. Press Reload.');
      const row = rows[i].slice();
      while (row.length < 17) row.push('');
      const cur = (row[11] || '') + (row[12] || ''), base = (row[15] || '') + (row[16] || '');
      const newText = undo ? base : text, newBase = undo ? ['', ''] : split(base || cur);
      const md = split(newText), pv = split(cur), stamp = now();
      if (cur && cur !== newText) await keepHistory([[S.siteId, url, row[8] || '', stamp, row[4] || '', pv[0], pv[1]]]);
      row[4] = undo ? 'live fetch' : 'edited by hand' + (name() ? ' (' + name() + ')' : '');
      row[8] = stamp; row[10] = '';
      row[11] = md[0]; row[12] = md[1]; row[13] = pv[0]; row[14] = pv[1]; row[15] = newBase[0]; row[16] = newBase[1];
      await sheet().api('/values/' + enc("'" + TAB.pages + "'!A" + (i + 1) + ':Q' + (i + 1)) + '?valueInputOption=RAW', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) });
      S.pageEdit = null;
      toast(undo ? 'Back to the page’s own text' : 'Saved your text for ' + pathLabel(url));
    } catch (e) { S.error = 'Couldn’t save the page text: ' + e.message; }
    S.job = null;
    await load();
  }

  async function ensureFilesTab() {
    if (S.filesTab) return;
    await sheet().api(':batchUpdate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB.files } } }] }) }).catch(e => {
      if (!/already exists/i.test(e.message)) throw e;
    });
    await sheet().api('/values/' + enc("'" + TAB.files + "'!A1:H1") + '?valueInputOption=RAW', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [FILE_COLS] }) });
    S.filesTab = true;
  }
  // kinds: {mine: text, base: text} for a version, {export: text}, or {reset: ''}
  async function writeFileRows(fname, version, kinds) {
    await ensureFilesTab();
    const stamp = now(), rows = [];
    Object.keys(kinds).forEach(kind => {
      const t = String(kinds[kind] || '');
      const n = Math.max(1, Math.ceil(t.length / CELL));
      for (let i = 0; i < n; i++) rows.push([S.siteId, fname, version, kind, stamp, name(), String(i + 1), t.slice(i * CELL, (i + 1) * CELL)]);
    });
    await sheet().api('/values/' + enc("'" + TAB.files + "'!A:H") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: rows }) });
  }
  async function saveVersion(fname, text, label) {
    S.job = { label: label, status: 'Saving', progress: '' }; S.error = ''; draw();
    try {
      await writeFileRows(fname, 'v' + Date.now().toString(36), { mine: text, base: generated()[fname] });
      delete S.choices[S.siteId + '|' + fname];
      S.editing = null;
      toast('Saved as your version of ' + fname);
    } catch (e) { S.error = 'Couldn’t save your version: ' + e.message; }
    S.job = null;
    await loadExtras(); draw();
  }
  async function resetVersion(fname) {
    S.job = { label: 'Use generated ' + fname, status: 'Saving', progress: '' }; draw();
    try { await writeFileRows(fname, 'r' + Date.now().toString(36), { reset: '' }); toast(fname + ' follows the pages again'); }
    catch (e) { S.error = 'Couldn’t switch back: ' + e.message; }
    S.job = null;
    await loadExtras(); draw();
  }
  async function saveToDrive() {
    S.job = { label: 'Save to Drive', status: 'Saving', progress: '' }; S.error = ''; draw();
    const id = 'x' + Date.now().toString(36);
    try {
      for (const f of ['llms.txt', 'llms-full.txt']) await writeFileRows(f, id, { export: output(f).text });
    } catch (e) { S.error = 'Couldn’t prepare the files: ' + e.message; S.job = null; draw(); return; }
    S.job = null;
    enqueue('save-drive', id, 'Save to Drive');
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
    u.state = !u.url ? 'nourl' : !p || !p.markdown ? 'new' : (p.editBase || p.markdown) === u.md ? 'same' : 'changed';
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
  const generated = () => { const st = site(), ps = livePages(); return { 'llms.txt': C.buildLlmsTxt(st, ps), 'llms-full.txt': C.buildLlmsFull(st, ps) }; };
  const files = () => ({ 'llms.txt': output('llms.txt').text, 'llms-full.txt': output('llms-full.txt').text });
  const latestVersion = f => { const v = S.versions.find(x => x.site === S.siteId && x.file === f); return v && !v.reset ? v : null; };
  const fileUrl = f => String(site().base || '').replace(/\/+$/, '') + '/' + f;

  // What a file is right now: generated from the pages, or your saved
  // version with whatever the pages changed since then merged in.
  function output(f) {
    const gen = generated()[f], v = latestVersion(f);
    if (!v) return { text: gen, mode: 'generated', conflicts: [], applied: 0 };
    // llms-full.txt follows your file page by page (matched on each section's URL),
    // so a hand-written file in its own format never gets pages twice.
    const F = f === 'llms-full.txt' ? C.followFull(v.base, v.mine, gen) : null;
    if (!F && v.base === gen) return { text: v.mine, mode: 'mine', conflicts: [], applied: 0, v: v };
    const r = F ? { text: F.text, conflicts: F.conflicts, applied: F.updated.length } : C.merge3(v.base, v.mine, gen);
    const pick = S.choices[S.siteId + '|' + f] || {};
    const lines = r.text.split('\n');
    r.conflicts.slice().reverse().forEach((c, ri) => {
      const i = r.conflicts.length - 1 - ri;
      // pick[i]: true = the new text from the pages, a string = what you typed in its place
      const use = typeof pick[i] === 'string' ? pick[i] : pick[i] ? c.theirs : null;
      if (use != null) lines.splice(c.at, c.mine ? c.mine.split('\n').length : 0, ...(use ? use.split('\n') : []));
    });
    const changed = r.applied || r.conflicts.length || (F && (F.added.length || F.text !== v.mine));
    return { text: lines.join('\n'), mode: changed ? 'merged' : 'mine', conflicts: r.conflicts, applied: r.applied, v: v, pick: pick,
      sections: !!F, added: F ? F.added : [], removed: F ? F.removed : [], dupes: F ? F.dupes : [] };
  }

  // Comments on one "New from the pages" box: stored in the Line Comments tab
  // like line comments, under "<file> review" and keyed by the new text, so
  // they stay with that change.
  const textKey = s => { let h = 0; s = String(s || '').trim(); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return 'r' + (h >>> 0).toString(36); };
  const reviewId = f => f + ' review';
  const cmLabel = n => n ? n + ' comment' + (n > 1 ? 's' : '') + ' on this change' : 'Comment on this change';
  function reviewComments(fname, c) {
    const diffId = reviewId(fname), key = textKey(c.theirs);
    const list = (((S.comments[fileUrl(fname)] || {})[diffId]) || {})[key] || [];
    const open = list.filter(x => !x.resolved).length;
    const canPost = !!(window.SchemaApp && window.SchemaApp.onPostComment);
    return '<div class="lx-conf-cm" data-cm-url="' + esc(fileUrl(fname)) + '"><div class="row lx-conf-row">' +
      '<span class="cell" style="display:none"><span class="tx">' + esc(c.theirs || '') + '</span></span>' +
      '<span class="cmcell">' + D.commentButton(diffId, key, open, list.length) + '</span>' +
      '<button type="button" class="lx-conf-cml" data-n="' + list.length + '">' + cmLabel(list.length) + '</button></div>' +
      (list.length ? D.commentPanel(diffId, key, list, canPost) : '') + '</div>';
  }

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
    if (!S.clearInputs) ['lx-urls', 'lx-add', 'lx-paste-url', 'lx-paste-src', 'lx-edit-llms.txt', 'lx-edit-llms-full.txt'].forEach(id => { if ($(id)) keep[id] = $(id).value; });
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
    return [drawSites(), drawError(), drawFiles(), drawGet(), drawWeekly(), drawStats(), drawList(), drawHistory(), drawNotes()].join('');
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
    const st = site(), d = lastDrive(), b = !!S.job;
    const row = (fname, desc) => {
      const o = output(fname), shown = S.preview === fname, editing = S.editing === fname;
      const chip = o.mode === 'generated' ? '<span class="lx-chip">Generated from the pages</span>'
        : '<span class="lx-chip lx-chip-mine">Your version · ' + esc(when(o.v.savedAt)) + (o.v.by ? ' · ' + esc(o.v.by) : '') + '</span>' +
          (o.sections && o.added.length ? '<span class="lx-chip lx-chip-new">+ ' + o.added.length + ' new page' + (o.added.length > 1 ? 's' : '') + ' added</span>' : '') +
          (o.applied ? '<span class="lx-chip lx-chip-new">+ ' + o.applied + ' page update' + (o.applied > 1 ? 's' : '') + ' merged in</span>' : '') +
          (o.conflicts.length ? '<span class="lx-chip lx-chip-warn">' + o.conflicts.length + (o.sections ? ' page' + (o.conflicts.length > 1 ? 's' : '') + ' changed on the site' : ' to review') + '</span>' : '') +
          (o.sections && (o.removed.length || o.dupes.length) ? '<span class="lx-chip lx-chip-warn">' + (o.removed.length + o.dupes.length) + ' note' + (o.removed.length + o.dupes.length > 1 ? 's' : '') + '</span>' : '');
      const cmAll = ((S.comments[fileUrl(fname)] || {})[fname]) || {};
      const cmRev = ((S.comments[fileUrl(fname)] || {})[reviewId(fname)]) || {};
      const openCm = [cmAll, cmRev].reduce((n, m) => n + Object.values(m).reduce((k, l) => k + l.filter(c => !c.resolved).length, 0), 0);
      let body = '';
      if (editing) {
        body = '<div class="lx-editor"><label for="lx-edit-' + fname + '">Edit ' + fname + '</label>' +
          '<textarea id="lx-edit-' + fname + '" class="lx-edit-ta" rows="22" spellcheck="false">' + esc(o.text) + '</textarea>' +
          '<p class="lx-hint">After you save, this file follows your version: later page updates are merged into it, and anything you changed by hand is kept. Where a page changes a line you also changed, your line stays and is listed for review.</p>' +
          '<div class="lx-row"><button type="button" class="primary" data-lx="save-edit" data-file="' + fname + '"' + (b ? ' disabled' : '') + '>Save as my version</button>' +
          '<button type="button" data-lx="cancel-edit">Cancel</button></div></div>';
      } else if (shown) {
        let conf = '';
        if (o.sections && (o.added.length || o.removed.length || o.dupes.length)) {
          const li = x => '<li>' + esc(x.title || '') + ' <span class="lx-size">' + esc(pathLabel(x.url || x)) + '</span></li>';
          conf += '<div class="lx-fnotes">' +
            (o.added.length ? '<p><b>Added in your format</b> (new pages, placed next to pages from the same part of the site):</p><ul>' + o.added.map(li).join('') + '</ul>' : '') +
            (o.removed.length ? '<p><b>In your version but no longer tracked</b>. They stay in your file; remove them with Edit if the pages are gone:</p><ul>' + o.removed.map(li).join('') + '</ul>' : '') +
            (o.dupes.length ? '<p><b>In your version more than once</b>. Remove the extra copy with Edit:</p><ul>' + o.dupes.map(u => li({ url: u })).join('') + '</ul>' : '') + '</div>';
        }
        if (o.conflicts.length) {
          const secs = o.sections;
          conf += '<div class="lx-conf"><b>' + o.conflicts.length + (secs ? ' page' + (o.conflicts.length > 1 ? 's' : '') + ' changed on the website since your version.</b> Your section is kept unless you pick the new one.'
            : ' place' + (o.conflicts.length > 1 ? 's' : '') + ' where the pages changed text you edited.</b> Your text is used unless you pick the new one.') +
            o.conflicts.map((c, i) => (secs ? '<div class="lx-conf-p"><b>' + esc(c.page || '') + '</b> <span class="lx-size">' + esc(pathLabel(c.url || '')) + '</span>' +
              (c.base ? (() => { const d = D.compare(c.base, c.theirs, { text: true, full: false, context: 2, labels: { left: 'Website before', right: 'Website now' } }); return d.error ? '' : '<details class="lx-conf-what"><summary>What changed on the website</summary><div class="lx-diff">' + d.html + '</div></details>'; })() : '') + '</div>' : '') +
              '<div class="lx-conf-i"><div><span class="lx-conf-l">' + (secs ? 'Your section' : 'Your text') + '</span><pre>' + esc(c.mine || '(you removed this)') + '</pre></div>' +
              '<div><label class="lx-conf-l" for="lx-conf-' + fname + '-' + i + '">' + (secs ? 'New from the website' : 'New from the pages') + ' (you can type here)</label>' +
              '<textarea id="lx-conf-' + fname + '-' + i + '" class="lx-conf-ta" data-lx-conf="' + fname + '" data-i="' + i + '" spellcheck="false" rows="' +
              Math.min(10, Math.max(2, (typeof o.pick[i] === 'string' ? o.pick[i] : c.theirs || '').split('\n').length + 1)) + '"' +
              (c.theirs ? '' : ' placeholder="(removed from the pages)"') + '>' + esc(typeof o.pick[i] === 'string' ? o.pick[i] : c.theirs || '') + '</textarea>' +
              reviewComments(fname, c) + '</div>' +
              '<button type="button" class="mini" data-lx="pick" data-file="' + fname + '" data-i="' + i + '">' + (o.pick[i] !== undefined && o.pick[i] !== false ? 'Use mine instead' : 'Use this box') + '</button></div>').join('') +
            '<div class="lx-row"><button type="button" class="primary" data-lx="bake" data-file="' + fname + '"' + (b ? ' disabled' : '') + '>Save my changes</button>' +
            '<span class="lx-hint">Saves what you picked or typed above as your version. Places you didn’t touch keep your text.</span></div></div>';
        }
        const keep = o.mode === 'merged'
          ? '<button type="button" class="mini primary" data-lx="bake" data-file="' + fname + '"' + (b ? ' disabled' : '') + '>Save this as my version</button>' : '';
        const reset = o.mode !== 'generated'
          ? '<button type="button" class="mini" data-lx="reset" data-file="' + fname + '"' + (b ? ' disabled' : '') + '>Stop following my version</button>' : '';
        const view = D.singleView(o.text, { diffId: fname, comments: cmAll, canPost: !!(window.SchemaApp && window.SchemaApp.onPostComment) });
        const orphan = orphanComments(o.text, cmAll);
        body = conf + (keep || reset ? '<div class="lx-row lx-vbar">' + keep + reset + '</div>' : '') +
          '<p class="lx-hint">Click 💬 next to a line to comment on it; highlight part of a line first to quote it.</p>' +
          '<div class="lx-view" data-cm-url="' + esc(fileUrl(fname)) + '">' + view + '</div>' +
          (orphan.length ? '<details class="lx-orphan"><summary>' + orphan.length + ' comment' + (orphan.length > 1 ? 's' : '') + ' on lines that have since changed</summary><ul class="cm-list">' +
            orphan.map(D.commentItem).join('') + '</ul></details>' : '');
      }
      return '<div class="lx-file"><div class="lx-file-top"><div><b>' + fname + '</b> <span class="lx-size">' + kb(o.text) + '</span>' +
        (openCm ? ' <span class="lx-cmc">💬 ' + openCm + '</span>' : '') +
        '<div class="lx-file-d">' + desc + '</div><div class="lx-chips">' + chip + '</div></div><div class="lx-row">' +
        '<button type="button" class="mini" data-lx="preview" data-file="' + fname + '" aria-expanded="' + shown + '">' + (shown ? 'Hide' : 'View &amp; comment') + '</button>' +
        '<button type="button" class="mini" data-lx="edit" data-file="' + fname + '"' + (b ? ' disabled' : '') + '>Edit</button>' +
        '<button type="button" class="mini" data-lx="copy" data-file="' + fname + '">Copy</button>' +
        '<button type="button" class="mini primary" data-lx="download" data-file="' + fname + '">Download</button></div></div>' + body + '</div>';
    };
    const driveLine = d && d.result && d.result.files
      ? 'Last saved to Drive ' + esc(when(d.finished)) + (d.by ? ' by ' + esc(d.by) : '') + ': ' + d.result.files.map(x => '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a>').join(', ')
      : 'Not saved to Drive yet.';
    return '<div class="lx-card"><div class="lx-files-h"><div><h3>Files for the developer</h3>' +
      '<p class="lx-hint">Built from the ' + livePages().length + ' saved pages of ' + esc(st.name) + ', or from your edited version when you have one. Send both to the developer to upload to the site root.</p></div>' +
      '<button type="button" data-lx="drive"' + (b || !livePages().length ? ' disabled' : '') + '>Save both to Drive</button></div>' +
      row('llms.txt', (st.intro ? 'Intro from the sheet' : 'Site name and summary') + (st.links ? ' + a linked list of every page' : '')) +
      row('llms-full.txt', 'The full text of every page, one after another') +
      '<p class="lx-hint lx-drive">' + driveLine + '</p></div>';
  }

  // Comments whose line no longer exists in the file (its text was edited).
  function orphanComments(text, cm) {
    const d = text.split('\n').map(s => ({ s: s }));
    const keys = new Set();
    // same keys as D.singleView: trimmed line text hash, #n for repeats
    const seen = {};
    d.forEach(x => {
      const t = String(x.s).trim(), m = t.match(/^"([^"]+)":/);
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
      const base = m ? m[1] : 'h' + (h >>> 0).toString(36);
      const n = (seen[base] = (seen[base] || 0) + 1);
      keys.add(n > 1 ? base + '#' + n : base);
    });
    return [].concat.apply([], Object.keys(cm).filter(k => !keys.has(k)).map(k => cm[k]));
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
    // New and changed pages first, then ones to review or that failed, then the rest (latest change first).
    const rank = x => x.r && (x.r.s === 'new' || x.r.s === 'changed') ? 0 : /^Review:/.test(x.p.lastError) ? 1 : x.r && x.r.s === 'failed' ? 2 : 3;
    const order = (a, b) => rank(a) - rank(b) || String(b.p.lastChanged).localeCompare(String(a.p.lastChanged)) || String(a.p.url).localeCompare(String(b.p.url));
    const rows = f === 'all'
      ? all.filter(p => !p.removed).map(p => ({ p: p, r: res.get(p.url) })).sort(order)
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
    if (p.editBase) meta.push('Has your edits');
    const review = /^Review:/.test(p.lastError) ? p.lastError.replace(/^Review:\s*(.)/, (m, c) => c.toUpperCase()) : '';
    const err = r && r.e ? r.e : (!r && p.lastError && !review ? 'Last try: ' + p.lastError : '');
    const b = !!S.job, editing = S.pageEdit === p.url;
    let detail = '';
    if (editing) {
      const id = 'lx-pe-' + p.row;
      detail = '<div class="lx-editor"><label for="' + id + '">Edit the text of ' + esc(pathLabel(p.url)) + '</label>' +
        '<textarea id="' + id + '" class="lx-edit-ta" rows="18" spellcheck="false">' + esc(p.markdown) + '</textarea>' +
        '<p class="lx-hint">This text goes into llms-full.txt. When the page changes later, its changes are merged into your text and your edits are kept.</p>' +
        '<div class="lx-row"><button type="button" class="primary" data-lx="page-save" data-url="' + esc(p.url) + '" data-ta="' + id + '"' + (b ? ' disabled' : '') + '>Save page text</button>' +
        '<button type="button" data-lx="page-cancel">Cancel</button></div></div>';
    } else if (open && canOpen) {
      if (p.previous && p.previous !== p.markdown) {
        const d = D.compare(p.previous, p.markdown, { text: true, full: false, context: 3, labels: { left: 'Before', right: 'Now' } });
        detail = '<div class="lx-sub">Last change</div>' + (d.error ? '<div class="lx-rerr">' + esc(d.error) + '</div>' : '<div class="lx-diff">' + d.html + '</div>');
      } else detail = '<pre class="lx-pre">' + esc(p.markdown || '(no text saved)') + '</pre>';
      detail += pageHistory(p);
      if (p.markdown) detail += '<div class="lx-row lx-pe-bar"><button type="button" class="mini" data-lx="page-edit" data-url="' + esc(p.url) + '"' + (b ? ' disabled' : '') + '>Edit text</button>' +
        (p.editBase ? '<button type="button" class="mini" data-lx="page-undo" data-url="' + esc(p.url) + '"' + (b ? ' disabled' : '') + '>Undo my edits</button>' : '') + '</div>';
    }
    return '<div class="lx-r' + (open ? ' open' : '') + '"><div class="lx-r-top">' +
      (canOpen ? '<button type="button" class="lx-tog" data-lx="toggle" data-url="' + esc(p.url) + '" aria-expanded="' + open + '">' : '<div class="lx-tog lx-tog-static">') +
      '<span class="lx-path">' + esc(pathLabel(p.url)) + '</span><span class="lx-title">' + esc(p.title || '') + '</span>' + (canOpen ? '</button>' : '</div>') +
      '<div class="lx-r-side">' + (st ? pill(st) : '') +
      '<a class="lx-ext" href="' + esc(p.url) + '" target="_blank" rel="noopener" aria-label="Open ' + esc(pathLabel(p.url)) + ' on the site">↗</a>' +
      (p.removed ? '' : '<button type="button" class="lx-x" data-lx="remove" data-url="' + esc(p.url) + '" aria-label="Stop tracking ' + esc(pathLabel(p.url)) + '"' + (S.job ? ' disabled' : '') + '>Remove</button>') +
      '</div></div>' + (meta.length ? '<div class="lx-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
      (err ? '<div class="lx-rerr">' + esc(err) + '</div>' : '') + (review ? '<div class="lx-rrev">' + esc(review) + '</div>' : '') + detail + '</div>';
  }

  // Older versions of one page, compared with each other or with the text now.
  function pageHistory(p) {
    const list = S.hist.filter(h => h.site === S.siteId && h.url === p.url).sort((a, b) => b.at.localeCompare(a.at));
    if (!list.length) return '';
    const pick = S.histPick[p.url] || { a: list[0].at, b: 'now' };
    const opt = (sel, includeNow) => (includeNow ? '<option value="now"' + (sel === 'now' ? ' selected' : '') + '>Now (since ' + esc(when(p.lastChanged)) + ')</option>' : '') +
      list.map(h => '<option value="' + esc(h.at) + '"' + (sel === h.at ? ' selected' : '') + '>Since ' + esc(when(h.since)) + ' → replaced ' + esc(when(h.at)) + (h.from ? ' · ' + esc(h.from) : '') + '</option>').join('');
    const id = 'lx-h-' + p.row;
    let h = '<details class="lx-hist"' + (pick.shown ? ' open' : '') + '><summary>History · ' + list.length + ' older version' + (list.length > 1 ? 's' : '') + '</summary><div class="lx-hist-b">' +
      '<div class="lx-hist-pick"><label for="' + id + 'a">From</label><select id="' + id + 'a" data-hist="a" data-url="' + esc(p.url) + '">' + opt(pick.a, false) + '</select>' +
      '<label for="' + id + 'b">to</label><select id="' + id + 'b" data-hist="b" data-url="' + esc(p.url) + '">' + opt(pick.b, true) + '</select>' +
      '<button type="button" class="mini" data-lx="hist-cmp" data-url="' + esc(p.url) + '">Compare</button></div>';
    if (pick.shown) {
      const txt = at => at === 'now' ? p.markdown : S.histText[S.siteId + '|' + p.url + '|' + at];
      const A = txt(pick.a), B = txt(pick.b);
      if (pick.err) h += '<div class="lx-rerr">' + esc(pick.err) + '</div>';
      else if (A == null || B == null) h += '<p class="lx-hint">Loading…</p>';
      else if (A === B) h += '<p class="lx-hint">These two versions are the same.</p>';
      else { const d = D.compare(A, B, { text: true, full: false, context: 3, labels: { left: 'From', right: 'To' } }); h += d.error ? '<div class="lx-rerr">' + esc(d.error) + '</div>' : '<div class="lx-diff">' + d.html + '</div>'; }
    }
    return h + '</div></details>';
  }

  /* ---------- history card: updates and file versions ---------- */

  const ACTION = { update: 'Checked pages & updated', add: 'Added pages', upload: 'Uploaded pages', remove: 'Removed pages', restore: 'Tracked again',
    check: 'Weekly check (nothing saved)', 'save-drive': 'Saved both files to Drive' };
  function drawHistory() {
    const tabs = '<div class="lx-ways" role="tablist" aria-label="History">' + [['updates', 'Updates'], ['files', 'File versions']].map(t =>
      '<button type="button" role="tab" data-lx="hist-tab" data-tab="' + t[0] + '" aria-selected="' + (S.histTab === t[0]) + '"' + (S.histTab === t[0] ? ' class="on"' : '') + '>' + t[1] + '</button>').join('') + '</div>';
    return '<div class="lx-card"><div class="lx-list-h"><h3>History</h3>' + tabs + '</div>' + (S.histTab === 'files' ? drawFileHistory() : drawUpdates()) + '</div>';
  }
  function drawUpdates() {
    const jobs = S.queue.filter(q => q.site === S.siteId && ACTION[q.action] && (q.status === 'Done' || q.status === 'Failed'))
      .sort((a, b) => (b.finished || b.at).localeCompare(a.finished || a.at));
    if (!jobs.length) return '<p class="lx-hint">Nothing yet. Every update, upload, weekly check and Drive save will be listed here.</p>';
    const max = 15 + S.histMore;
    return '<ul class="lx-hlist">' + jobs.slice(0, max).map(q => {
      const res = q.result || {}, list = res.results || [], c = {};
      list.forEach(x => { c[x.s] = (c[x.s] || 0) + 1; });
      const parts = q.status === 'Failed' ? ['Failed: ' + (res.error || 'unknown error')]
        : q.action === 'save-drive' ? (res.files || []).map(f => f.name)
        : ['new', 'changed', 'failed', 'same', 'removed', 'restored'].filter(k => c[k]).map(k => c[k] + ' ' + (PILL[k] ? PILL[k][0].toLowerCase() : k));
      const open = !!S.histOpen[q.id], canOpen = list.length > 0 || (res.files || []).length > 0;
      let h = '<li><div class="lx-hrow">' + (canOpen ? '<button type="button" class="lx-tog" data-lx="hist-open" data-id="' + esc(q.id) + '" aria-expanded="' + open + '">' : '<div class="lx-tog lx-tog-static">') +
        '<span class="lx-hwhen">' + esc(when(q.finished || q.at)) + '</span><span class="lx-hwhat">' + esc(ACTION[q.action]) + (q.by ? ' · ' + esc(q.by) : '') + '</span>' +
        '<span class="lx-hsum">' + esc(parts.join(', ') || 'No changes') + (res.trimmed ? ' (unchanged pages not listed)' : '') + '</span>' + (canOpen ? '</button>' : '</div>') + '</div>';
      if (open) {
        h += q.action === 'save-drive'
          ? '<ul class="lx-hpages">' + (res.files || []).map(f => '<li><a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.name) + '</a></li>').join('') + '</ul>'
          : '<ul class="lx-hpages">' + list.filter(x => x.s !== 'same').concat(list.filter(x => x.s === 'same')).map(x =>
            '<li>' + pill(x.s) + '<span class="lx-path">' + esc(pathLabel(x.u)) + '</span>' + (x.e ? '<span class="lx-herr">' + esc(x.e) + '</span>' : '') + '</li>').join('') + '</ul>';
      }
      return h + '</li>';
    }).join('') + '</ul>' + (jobs.length > max ? '<button type="button" class="mini" data-lx="hist-more">Show ' + Math.min(30, jobs.length - max) + ' more</button>' : '');
  }
  // Every saved version of a file: yours, and exactly what went to Drive (the developer).
  function fileVersions(f) {
    const out = [{ id: 'now', label: 'Now: ' + (output(f).mode === 'generated' ? 'generated from the pages' : 'your version + page updates'), text: output(f).text }];
    S.exports.filter(v => v.site === S.siteId && v.file === f).forEach(v => out.push({ id: 'x:' + v.version, at: v.savedAt, label: 'Sent to Drive · ' + when(v.savedAt) + (v.by ? ' · ' + v.by : ''), text: v.text }));
    S.versions.filter(v => v.site === S.siteId && v.file === f).forEach(v => out.push(v.reset
      ? { id: 'r:' + v.version, at: v.savedAt, label: 'Stopped following your version · ' + when(v.savedAt) + (v.by ? ' · ' + v.by : ''), text: null }
      : { id: 'm:' + v.version, at: v.savedAt, label: 'Your version saved · ' + when(v.savedAt) + (v.by ? ' · ' + v.by : ''), text: v.mine }));
    return [out[0]].concat(out.slice(1).sort((a, b) => b.at.localeCompare(a.at)));
  }
  function drawFileHistory() {
    const f = S.fileCmp.file || 'llms-full.txt';
    const vs = fileVersions(f), cmp = vs.filter(v => v.text != null);
    const lastSent = vs.find(v => v.id.indexOf('x:') === 0);
    const a = S.fileCmp.a && cmp.some(v => v.id === S.fileCmp.a) ? S.fileCmp.a : (lastSent ? lastSent.id : (cmp[1] || cmp[0]).id);
    const b = S.fileCmp.b && cmp.some(v => v.id === S.fileCmp.b) ? S.fileCmp.b : 'now';
    const sel = (id, cur) => '<select id="' + id + '">' + cmp.map(v => '<option value="' + esc(v.id) + '"' + (v.id === cur ? ' selected' : '') + '>' + esc(v.label) + '</option>').join('') + '</select>';
    let h = '<div class="lx-hist-pick"><label for="lx-hf">File</label><select id="lx-hf">' + ['llms.txt', 'llms-full.txt'].map(x => '<option' + (x === f ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<ul class="lx-hlist">' + vs.slice(1).map(v => '<li><div class="lx-hrow"><div class="lx-tog lx-tog-static"><span class="lx-hwhat">' + esc(v.label) + '</span></div></div></li>').join('') + '</ul>';
    if (vs.length < 2) return h + '<p class="lx-hint">No saved versions yet. Versions appear when you save your own version or press Save both to Drive.</p>';
    h += '<div class="lx-hist-pick"><label for="lx-hfa">Compare</label>' + sel('lx-hfa', a) + '<label for="lx-hfb">with</label>' + sel('lx-hfb', b) + '</div>' +
      (lastSent && a === lastSent.id && b === 'now' ? '<p class="lx-hint">Showing what changed since the last files sent to Drive (the developer’s copy).</p>' : '');
    const A = cmp.find(v => v.id === a).text, B = cmp.find(v => v.id === b).text;
    if (A === B) return h + '<p class="lx-hint">These two versions are the same.</p>';
    const d = D.compare(A, B, { text: true, full: false, context: 3, labels: { left: (cmp.find(v => v.id === a).label), right: (cmp.find(v => v.id === b).label) } });
    return h + (d.error ? '<div class="lx-rerr">' + esc(d.error) + '</div>' : '<div class="lx-diff">' + d.html + '</div>');
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
    if (t.dataset.site) { S.siteId = t.dataset.site; store.set('llms-site', S.siteId); S.filter = 'all'; S.open = {}; S.uploads = []; S.preview = null; S.editing = null; S.pageEdit = null; S.clearInputs = true; draw(); return; }
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
    else if (act === 'drive') saveToDrive();
    else if (act === 'edit') { S.editing = file; S.preview = null; draw(); const ta = $('lx-edit-' + file); if (ta) ta.focus(); }
    else if (act === 'cancel-edit') { S.editing = null; draw(); }
    else if (act === 'save-edit') {
      const text = $('lx-edit-' + file).value;
      if (text === output(file).text && output(file).mode !== 'generated') { S.editing = null; draw(); return; }
      saveVersion(file, text, 'Save my version');
    }
    else if (act === 'bake') saveVersion(file, output(file).text, 'Save my version');
    else if (act === 'reset') {
      if (!window.confirm('Stop following your version of ' + file + '? It will be generated from the pages again. Your version stays in the “llms files” tab.')) return;
      resetVersion(file);
    }
    else if (act === 'pick') {
      const k = S.siteId + '|' + file, i = t.dataset.i;
      const p = S.choices[k] || (S.choices[k] = {});
      p[i] = p[i] !== undefined && p[i] !== false ? false : true; draw();
    }
    else if (act === 'toggle') { S.open[url] = !S.open[url]; draw(); }
    else if (act === 'hist-tab') { S.histTab = t.dataset.tab; draw(); }
    else if (act === 'hist-open') { S.histOpen[t.dataset.id] = !S.histOpen[t.dataset.id]; draw(); }
    else if (act === 'hist-more') { S.histMore += 30; draw(); }
    else if (act === 'hist-cmp') {
      const box = t.closest('.lx-hist-b'), pick = S.histPick[url] = S.histPick[url] || {};
      pick.a = box.querySelector('[data-hist="a"]').value; pick.b = box.querySelector('[data-hist="b"]').value;
      pick.shown = true; pick.err = ''; draw();
      const list = S.hist.filter(h => h.site === S.siteId && h.url === url && (h.at === pick.a || h.at === pick.b));
      histTexts(list).catch(er => { pick.err = 'Couldn’t load that version: ' + er.message; }).then(draw);
    }
    else if (act === 'page-edit') { S.pageEdit = url; draw(); const ta = $('llms').querySelector('.lx-r .lx-edit-ta'); if (ta) ta.focus(); }
    else if (act === 'page-cancel') { S.pageEdit = null; draw(); }
    else if (act === 'page-save') {
      const text = $(t.dataset.ta).value, p = sitePages().find(x => x.url === url);
      if (p && text === p.markdown) { S.pageEdit = null; draw(); return; }
      savePageText(url, text, false);
    }
    else if (act === 'page-undo') {
      if (!window.confirm('Undo your edits to ' + pathLabel(url) + '? It goes back to the text from the page itself.')) return;
      savePageText(url, '', true);
    }
    else if (act === 'preview') { S.preview = S.preview === file ? null : file; S.editing = null; draw(); }
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
    if (t.dataset.hist) { const p = S.histPick[t.dataset.url] || (S.histPick[t.dataset.url] = {}); p[t.dataset.hist] = t.value; return; }
    if (t.id === 'lx-hf') { S.fileCmp = { file: t.value }; draw(); return; }
    if (t.id === 'lx-hfa' || t.id === 'lx-hfb') { S.fileCmp[t.id === 'lx-hfa' ? 'a' : 'b'] = t.value; S.fileCmp.file = S.fileCmp.file || 'llms-full.txt'; draw(); return; }
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
    $('llms').classList.toggle('tab-off', !llms);   // .llms sets display, which beats [hidden]
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
    // Typing in a review box: remember the text and use it for that place.
    host.addEventListener('input', e => {
      const ta = e.target.closest && e.target.closest('[data-lx-conf]');
      if (!ta) return;
      const k = S.siteId + '|' + ta.dataset.lxConf;
      (S.choices[k] || (S.choices[k] = {}))[ta.dataset.i] = ta.value;
      const btn = ta.closest('.lx-conf-i').querySelector('[data-lx="pick"]');
      if (btn) btn.textContent = 'Use mine instead';
    });
    // Highlight part of a "New from the pages" box, then press 💬 to quote it.
    const confSel = ta => ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
    const markConf = e => {
      const ta = e.target.closest && e.target.closest('.lx-conf-ta');
      if (!ta) return;
      const row = ta.parentElement.querySelector('.lx-conf-row'), l = row && row.querySelector('.lx-conf-cml');
      if (!row) return;
      const hit = !!confSel(ta);
      row.classList.toggle('sel-hit', hit);
      l.textContent = hit ? 'Comment on the highlighted text' : cmLabel(+l.dataset.n || 0);
    };
    host.addEventListener('mouseup', e => setTimeout(() => markConf(e), 0));
    host.addEventListener('keyup', markConf);
    host.addEventListener('click', e => {
      const lab = e.target.closest('.lx-conf-cml');
      if (lab) { lab.parentElement.querySelector('.ln-cm-btn').click(); return; }
      const btn = e.target.closest('.lx-conf-cm .ln-cm-btn');
      if (!btn) return;
      const ta = btn.closest('.lx-conf-cm').parentElement.querySelector('.lx-conf-ta'), snip = ta ? confSel(ta) : '';
      // app.js opens the panel on this same click; fill in the quote after it.
      setTimeout(() => {
        const panel = btn.closest('.row').nextElementSibling;
        if (!snip || !panel || !panel.classList.contains('ln-cm-panel')) return;
        panel.hidden = false;
        panel.dataset.snippet = snip;
        const q = panel.querySelector('.ln-cm-quote');
        if (q) { q.textContent = snip; panel.querySelector('.cm-on').hidden = false; }
        const body = panel.querySelector('.cm-body'); if (body) body.focus();
      }, 0);
    });
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
    document.addEventListener('line-comment-posted', e => {
      const d = e.detail || {};
      if (!/\/llms(-full)?\.txt$/.test(d.url || '')) return;
      addComment(d.url, d.diffId, d.lineKey, d.comment);
      const lbl = document.querySelector('.lx-conf-cm .ln-cm-panel[data-line-key="' + d.lineKey + '"]');
      const row = lbl && lbl.previousElementSibling, l = row && row.querySelector('.lx-conf-cml');
      if (l) { const n = lbl.querySelectorAll('.cm-item').length; l.dataset.n = n; if (!row.classList.contains('sel-hit')) l.textContent = cmLabel(n); }
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
