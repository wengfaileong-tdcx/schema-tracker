/* llms.txt tab: shows what the GitHub crawler (.github/workflows/llms.yml)
   saved under llms/<site>/, starts new runs, and hands out llms.txt and
   llms-full.txt for the developer to upload.

   Reading needs nothing (the repo is public). Starting a run needs a GitHub
   token with "Actions: read and write" on this repo; it is kept in this
   browser only (localStorage) and sent only to api.github.com. */
(function () {
  const cfg = window.LLMS_CONFIG || {};
  if (!cfg.repo) return;
  const D = window.SchemaDiff;
  const esc = D.esc;
  const $ = id => document.getElementById(id);
  const API = 'https://api.github.com/repos/' + cfg.repo;
  const BRANCH = cfg.branch || 'main';
  const WORKFLOW = cfg.workflow || 'llms.yml';
  const TOKEN_KEY = 'llms-gh-token';

  const store = {
    get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };

  const S = {
    sites: [], siteId: '', index: null, run: null, check: null,
    files: {}, open: {}, filter: 'all', busy: null, error: '', loaded: false
  };

  /* ---------- GitHub ---------- */

  function headers(raw) {
    const h = { Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const t = store.get(TOKEN_KEY);
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  // Repo files through the API (no Pages cache delay); falls back to the
  // copy Pages serves next to this page.
  async function readFile(p, asJson) {
    let res;
    try {
      res = await fetch(API + '/contents/' + p + '?ref=' + BRANCH + '&t=' + Date.now(), { headers: headers(true), cache: 'no-store' });
    } catch (e) { res = null; }
    if (!res || (res.status !== 200 && res.status !== 404)) {
      try { res = await fetch(p + '?t=' + Date.now(), { cache: 'no-store' }); } catch (e) { res = null; }
    }
    if (!res || res.status === 404) return null;
    if (!res.ok) throw new Error('Couldn’t read ' + p + ' (HTTP ' + res.status + ')');
    return asJson ? res.json() : res.text();
  }

  async function startRun(inputs) {
    const res = await fetch(API + '/actions/workflows/' + WORKFLOW + '/dispatches', {
      method: 'POST', headers: Object.assign(headers(false), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ref: BRANCH, inputs: inputs })
    });
    if (res.status === 401) throw new Error('GitHub didn’t accept the token. Connect again with a new one.');
    if (res.status === 403 || res.status === 404) throw new Error('The token can’t start runs here. It needs “Actions: Read and write” on ' + cfg.repo + '.');
    if (res.status !== 204) throw new Error('GitHub said ' + res.status + ': ' + (await res.text()).slice(0, 200));
  }

  async function latestRuns() {
    const res = await fetch(API + '/actions/workflows/' + WORKFLOW + '/runs?per_page=5&t=' + Date.now(), { headers: headers(false), cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()).workflow_runs || [];
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function run(inputs, label) {
    if (!store.get(TOKEN_KEY)) { S.connectOpen = true; draw(); $('lx-token') && $('lx-token').focus(); return; }
    const before = new Date(Date.now() - 5000).toISOString();
    S.busy = { label: label, step: 'Starting…', url: '' }; S.error = ''; draw();
    try {
      await startRun(Object.assign({ mode: 'update', site: S.siteId, urls: '', add_urls: '', remove_urls: '' }, inputs));
      let found = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 20 * 60000) {
        await wait(found ? 6000 : 3000);
        const runs = await latestRuns();
        found = runs.find(r => r.event === 'workflow_dispatch' && r.created_at >= before.slice(0, 19)) || found;
        if (!found) { S.busy.step = 'Waiting for GitHub to pick it up…'; draw(); continue; }
        S.busy.url = found.html_url;
        if (found.status !== 'completed') {
          S.busy.step = found.status === 'queued' ? 'Queued on GitHub…' : 'Fetching pages on GitHub… (about 1–2 minutes)';
          draw(); continue;
        }
        if (found.conclusion !== 'success') throw new Error('The run ended with “' + found.conclusion + '”. Open it on GitHub to see why.');
        break;
      }
      S.busy.step = 'Loading results…'; draw();
      S.files = {};
      await loadSite();
      const lr = S.run;
      toast(lr ? 'Done: ' + (lr.counts.changed || 0) + ' changed, ' + (lr.counts.new || 0) + ' new' : 'Done');
      S.filter = 'run';
    } catch (e) {
      S.error = e.message || String(e);
    }
    const url = S.busy && S.busy.url;
    S.busy = null; S.lastRunUrl = url; draw();
  }

  /* ---------- data ---------- */

  async function loadSites() {
    const s = await readFile('llms/sites.json', true);
    S.sites = (s && s.sites) || [];
    S.siteId = S.siteId || store.get('llms-site') || (S.sites[0] && S.sites[0].id) || '';
    if (!S.sites.some(x => x.id === S.siteId)) S.siteId = S.sites[0] ? S.sites[0].id : '';
  }
  async function loadSite() {
    const base = 'llms/' + S.siteId + '/';
    const got = await Promise.all([readFile(base + 'index.json', true), readFile(base + 'last-run.json', true), readFile(base + 'last-check.json', true)]);
    S.index = got[0]; S.run = got[1]; S.check = got[2];
  }
  async function getFile(name) {
    if (S.files[name] == null) S.files[name] = (await readFile('llms/' + S.siteId + '/' + name, false)) || '';
    return S.files[name];
  }

  async function load() {
    S.error = '';
    try { await loadSites(); if (S.siteId) await loadSite(); }
    catch (e) { S.error = e.message || String(e); }
    S.loaded = true; draw();
  }

  /* ---------- helpers ---------- */

  const site = () => S.sites.find(s => s.id === S.siteId) || {};
  const when = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  const pathOf = u => { try { const x = new URL(u); return x.pathname === '/' ? '/ (home)' : x.pathname; } catch (e) { return u; } };
  const kb = s => s ? (s.length < 1024 ? s.length + ' B' : (s.length / 1024).toFixed(s.length < 10240 ? 1 : 0) + ' KB') : '—';
  const urlsIn = s => (s || '').split(/[\s,]+/).map(x => x.trim()).filter(x => /^https?:\/\//i.test(x));

  const PILL = {
    changed: ['Changed', 'lx-p-chg'], new: ['New', 'lx-p-new'], same: ['No change', 'lx-p-same'],
    failed: ['Couldn’t fetch', 'lx-p-fail'], removed: ['Removed', 'lx-p-same']
  };
  const pill = st => { const p = PILL[st] || [st, 'lx-p-same']; return '<span class="lx-pill ' + p[1] + '">' + p[0] + '</span>'; };

  function toast(text) {
    const t = $('toast');
    if (!t) return;
    t.textContent = text; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => toast('Copied to clipboard'), () => toast('Couldn’t copy. Your browser blocked it.'));
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------- drawing ---------- */

  function draw() {
    const host = $('llms');
    if (!host || host.hidden) return;
    const keep = $('lx-urls') ? $('lx-urls').value : (S.urlsDraft || '');
    S.urlsDraft = keep;
    if (!S.loaded) { host.innerHTML = '<div class="empty">Loading llms.txt data…</div>'; return; }
    host.innerHTML = [drawHead(), drawError(), drawWeekly(), drawUpdate(), drawStats(), drawList(), drawFiles(), drawNotes()].join('');
    if ($('lx-urls')) $('lx-urls').value = keep;
  }

  function drawHead() {
    const st = site();
    const sel = S.sites.length > 1
      ? '<label for="lx-site" class="sr-only">Site</label><select id="lx-site" style="width:auto">' +
        S.sites.map(s => '<option value="' + esc(s.id) + '"' + (s.id === S.siteId ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select>'
      : '<b class="lx-site">' + esc(st.name || 'No site set up') + '</b>';
    const tok = store.get(TOKEN_KEY);
    const conn = tok
      ? '<span class="lx-gh ok">GitHub connected</span> <button type="button" class="mini" data-lx="disconnect">Disconnect</button>'
      : '<button type="button" class="mini" data-lx="connect">Connect GitHub</button>';
    const form = S.connectOpen && !tok ? (
      '<div class="lx-connect"><p>To start updates from here, paste a GitHub <b>fine-grained token</b> that can only reach <code>' + esc(cfg.repo) + '</code>, ' +
      'with <b>Actions: Read and write</b> (nothing else). ' +
      '<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create one on GitHub</a>. ' +
      'It stays in this browser only.</p>' +
      '<div class="lx-row"><label for="lx-token" class="sr-only">GitHub token</label><input type="password" id="lx-token" placeholder="github_pat_…" autocomplete="off">' +
      '<button type="button" class="primary" data-lx="save-token">Save</button><button type="button" data-lx="cancel-token">Cancel</button></div></div>') : '';
    return '<div class="lx-head"><div>' + sel + (st.base ? ' <a class="lx-base" href="' + esc(st.base) + '" target="_blank" rel="noopener">' + esc(st.base.replace(/^https?:\/\//, '')) + '</a>' : '') +
      '<span class="lx-from">Fetches from: ' + (st.fetchFrom === 'staging' && st.stagingBase ? 'staging (' + esc(st.stagingBase) + ')' : 'live site') + '</span></div>' +
      '<div class="lx-conn">' + conn + '</div></div>' + form;
  }

  function drawError() {
    return S.error ? '<div class="lx-err" role="alert">' + esc(S.error) +
      (S.lastRunUrl ? ' <a href="' + esc(S.lastRunUrl) + '" target="_blank" rel="noopener">Open the run</a>' : '') + '</div>' : '';
  }

  function drawWeekly() {
    const c = S.check;
    if (!c || (S.run && S.run.at > c.at)) return '';
    const items = (c.results || []).filter(r => r.state === 'changed' || r.state === 'new');
    const failed = (c.results || []).filter(r => r.state === 'failed').length;
    if (!items.length && !failed) return '';
    return '<div class="lx-weekly"><div><b>Weekly check, ' + esc(when(c.at)) + ':</b> ' +
      (items.length ? items.length + ' page' + (items.length > 1 ? 's' : '') + ' changed or new since the last update' : 'nothing changed') +
      (failed ? ', ' + failed + ' couldn’t be fetched' : '') + '. The files haven’t been touched.</div>' +
      (items.length ? '<button type="button" class="mini" data-lx="use-weekly">Update these ' + items.length + ' pages</button>' : '') + '</div>';
  }

  function drawUpdate() {
    const b = S.busy;
    const last = S.index && S.index.updatedAt;
    return '<div class="lx-card lx-update"><div class="lx-update-main">' +
      '<label for="lx-urls">Pages the developer changed <span class="lx-opt">(optional, one per line)</span></label>' +
      '<textarea id="lx-urls" rows="3" placeholder="https://llmsource.com/pricing&#10;Leave empty to check every page, plus new pages in sitemap.xml"' + (b ? ' disabled' : '') + '></textarea>' +
      '<div class="lx-row lx-actions"><button type="button" class="primary" data-lx="update"' + (b ? ' disabled' : '') + '>Check pages &amp; update</button>' +
      '<span class="lx-last">' + (b
        ? '<span class="lx-spin" aria-hidden="true"></span><span role="status">' + esc(b.step) + '</span>' + (b.url ? ' <a href="' + esc(b.url) + '" target="_blank" rel="noopener">Watch on GitHub</a>' : '')
        : 'Last updated: ' + esc(when(last))) + '</span></div>' +
      '</div><p class="lx-hint">Runs on GitHub, takes 1–2 minutes. Only pages whose text changed are saved; both files are rebuilt after every update. ' +
      'A check also runs by itself every Monday at 9am and only reminds you here.</p></div>';
  }

  function counts() {
    const pages = (S.index && S.index.pages) || [];
    const tracked = pages.filter(p => !p.excluded);
    const res = (S.run && S.run.results) || [];
    return {
      tracked: tracked.length,
      changed: res.filter(r => r.state === 'changed').length,
      new: res.filter(r => r.state === 'new').length,
      failed: res.filter(r => r.state === 'failed').length
    };
  }

  function drawStats() {
    if (!S.index) return '';
    const c = counts();
    const tile = (k, n, label) => '<button type="button" class="lx-tile' + (S.filter === k ? ' on' : '') + '" data-lx-filter="' + k + '" aria-pressed="' + (S.filter === k) + '">' +
      '<b>' + n + '</b><span>' + label + '</span></button>';
    return '<div class="lx-tiles">' + tile('all', c.tracked, 'Pages tracked') + tile('changed', c.changed, 'Changed in last update') +
      tile('new', c.new, 'New in last update') + tile('failed', c.failed, 'Couldn’t fetch') + '</div>';
  }

  function drawList() {
    if (!S.index) {
      return '<div class="empty">Nothing saved yet. Press <b>Check pages &amp; update</b> to fetch every page in the sitemap for the first time.</div>';
    }
    const res = new Map(((S.run && S.run.results) || []).map(r => [r.url, r]));
    let pages = S.index.pages.filter(p => !p.excluded);
    const f = S.filter;
    let rows;
    if (f === 'all') rows = pages.map(p => ({ p: p, r: res.get(p.url) }));
    else rows = ((S.run && S.run.results) || []).filter(r => r.state === f).map(r => ({ p: S.index.pages.find(p => p.url === r.url) || { url: r.url, title: r.title }, r: r }));
    const head = f === 'all'
      ? 'All pages'
      : (PILL[f] ? PILL[f][0] : f) + ' in the last update' + (S.run ? ' (' + esc(when(S.run.at)) + (S.run.scope === 'selected' ? ', selected pages only' : '') + ')' : '');
    const body = rows.length ? rows.map(drawRow).join('') : '<div class="lx-none">None.</div>';
    const excluded = S.index.pages.filter(p => p.excluded);
    return '<div class="lx-card"><div class="lx-list-h"><h3>' + head + '</h3>' +
      '<div class="lx-add"><label for="lx-add" class="sr-only">Add a page</label><input type="text" id="lx-add" placeholder="Add a page not in the sitemap: https://…"' + (S.busy ? ' disabled' : '') + '>' +
      '<button type="button" class="mini" data-lx="add"' + (S.busy ? ' disabled' : '') + '>Add page</button></div></div>' +
      '<div class="lx-list">' + body + '</div>' +
      (excluded.length && f === 'all' ? '<details class="lx-excl"><summary>' + excluded.length + ' removed page' + (excluded.length > 1 ? 's' : '') + ' (left out of both files)</summary>' +
        excluded.map(p => '<div class="lx-xrow"><span>' + esc(pathOf(p.url)) + '</span><button type="button" class="mini" data-lx="readd" data-url="' + esc(p.url) + '"' + (S.busy ? ' disabled' : '') + '>Track again</button></div>').join('') + '</details>' : '') +
      '</div>';
  }

  function drawRow(x) {
    const p = x.p, r = x.r;
    const st = r ? r.state : null;
    const canOpen = r && (r.before != null || r.after != null);
    const open = !!S.open[p.url];
    const meta = [];
    if (p.lastChanged) meta.push('Text last changed ' + when(p.lastChanged));
    if (p.notInSitemap) meta.push('No longer in sitemap.xml');
    if (p.source === 'added') meta.push('Added by hand');
    let err = '';
    if (r && r.error) err = '<div class="lx-rerr">' + esc(r.error) + '</div>';
    else if (!r && p.lastError) err = '<div class="lx-rerr">Last try failed: ' + esc(p.lastError) + '</div>';
    let detail = '';
    if (open && canOpen) {
      if (st === 'changed') {
        const d = D.compare(r.before, r.after, { text: true, full: false, context: 3, labels: { left: 'Before', right: 'Now' } });
        detail = d.error ? '<div class="lx-rerr">' + esc(d.error) + '</div>' : '<div class="lx-diff">' + d.html + '</div>';
      } else {
        detail = '<pre class="lx-pre">' + esc(r.after || '') + '</pre>';
      }
    }
    return '<div class="lx-r' + (open ? ' open' : '') + '"><div class="lx-r-top">' +
      (canOpen ? '<button type="button" class="lx-tog" data-lx="toggle" data-url="' + esc(p.url) + '" aria-expanded="' + open + '">' : '<div class="lx-tog lx-tog-static">') +
      '<span class="lx-path">' + esc(pathOf(p.url)) + '</span><span class="lx-title">' + esc(p.title || '') + '</span>' +
      (canOpen ? '</button>' : '</div>') +
      '<div class="lx-r-side">' + (st ? pill(st) : '') +
      '<a class="lx-ext" href="' + esc(p.url) + '" target="_blank" rel="noopener" aria-label="Open ' + esc(pathOf(p.url)) + ' on the site">↗</a>' +
      (p.excluded ? '' : '<button type="button" class="lx-x" data-lx="remove" data-url="' + esc(p.url) + '" title="Stop tracking this page" aria-label="Stop tracking ' + esc(pathOf(p.url)) + '"' + (S.busy ? ' disabled' : '') + '>Remove</button>') +
      '</div></div>' + (meta.length ? '<div class="lx-meta">' + esc(meta.join(' · ')) + '</div>' : '') + err + detail + '</div>';
  }

  function drawFiles() {
    if (!S.index) return '';
    const f = (name, desc) => {
      const txt = S.files[name];
      const shown = S.preview === name;
      return '<div class="lx-file"><div class="lx-file-top"><div><b>' + name + '</b> <span class="lx-size">' + (txt == null ? '' : kb(txt)) + '</span>' +
        '<div class="lx-file-d">' + desc + '</div></div><div class="lx-row">' +
        '<button type="button" class="mini" data-lx="preview" data-file="' + name + '" aria-expanded="' + shown + '">' + (shown ? 'Hide' : 'Preview') + '</button>' +
        '<button type="button" class="mini" data-lx="copy" data-file="' + name + '">Copy</button>' +
        '<button type="button" class="mini primary" data-lx="download" data-file="' + name + '">Download</button></div></div>' +
        (shown ? '<pre class="lx-pre lx-file-pre">' + esc(txt == null ? 'Loading…' : (txt || '(empty)')) + '</pre>' : '') + '</div>';
    };
    const st = site();
    return '<div class="lx-card"><h3>Files for the developer</h3>' +
      '<p class="lx-hint">Built from the saved pages at the last update (' + esc(when(S.index.updatedAt)) + '). Download both and send them to the developer to upload to the site root.</p>' +
      f('llms.txt', 'Intro' + (st.llmsTxtLinks === false ? '' : ' + a linked list of every page with its description')) +
      f('llms-full.txt', 'The full text of every page, one after another') + '</div>';
  }

  function drawNotes() {
    return '<div class="lx-notes"><b>Good to know</b><ul>' +
      '<li>The intro at the top of llms.txt is <a href="https://github.com/' + esc(cfg.repo) + '/edit/' + BRANCH + '/llms/' + esc(S.siteId) + '/llms-intro.md" target="_blank" rel="noopener">llms-intro.md</a>. Edit it there; it’s used from the next update on.</li>' +
      '<li>Pages are read from their HTML. Text that only appears after JavaScript runs (e.g. an embedded cookie policy) can be missing; those pages show up as “Couldn’t fetch” or with short text.</li>' +
      '<li>Sites behind bot protection (Cloudflare “Just a moment…”) are not bypassed. Those pages keep their last good copy.</li>' +
      '<li>Every update is saved in the repo’s history, so older versions of both files can be recovered. The repo is public.</li>' +
      '<li>Schema is unchanged: it stays in the Google Sheet.</li></ul></div>';
  }

  /* ---------- events ---------- */

  async function onClick(e) {
    const t = e.target.closest('[data-lx],[data-lx-filter]');
    if (!t || !$('llms').contains(t)) return;
    if (t.dataset.lxFilter) { S.filter = t.dataset.lxFilter; draw(); return; }
    const act = t.dataset.lx, url = t.dataset.url, file = t.dataset.file;
    if (act === 'connect') { S.connectOpen = true; draw(); $('lx-token').focus(); }
    else if (act === 'cancel-token') { S.connectOpen = false; draw(); }
    else if (act === 'save-token') {
      const v = $('lx-token').value.trim();
      if (!v) { $('lx-token').focus(); return; }
      store.set(TOKEN_KEY, v); S.connectOpen = false; draw(); toast('GitHub connected');
    }
    else if (act === 'disconnect') { store.set(TOKEN_KEY, ''); draw(); toast('Token removed from this browser'); }
    else if (act === 'update') {
      const raw = $('lx-urls').value;
      const urls = urlsIn(raw);
      if (raw.trim() && !urls.length) { S.error = 'Those don’t look like full page addresses. Paste them starting with https://'; draw(); return; }
      run({ urls: urls.join(' ') }, urls.length ? 'Update ' + urls.length + ' pages' : 'Update all pages');
    }
    else if (act === 'use-weekly') {
      const urls = (S.check.results || []).filter(r => r.state === 'changed' || r.state === 'new').map(r => r.url);
      $('lx-urls').value = urls.join('\n'); S.urlsDraft = $('lx-urls').value;
      run({ urls: urls.join(' ') }, 'Update ' + urls.length + ' pages');
    }
    else if (act === 'add') {
      const urls = urlsIn($('lx-add').value);
      if (!urls.length) { $('lx-add').focus(); S.error = 'Paste the full address of the page, starting with https://'; draw(); return; }
      run({ add_urls: urls.join(' ') }, 'Add page');
    }
    else if (act === 'remove') {
      if (!window.confirm('Stop tracking ' + pathOf(url) + '? It will be left out of llms.txt and llms-full.txt from now on, and won’t be added back from the sitemap.')) return;
      run({ remove_urls: url }, 'Remove page');
    }
    else if (act === 'readd') run({ add_urls: url }, 'Track again');
    else if (act === 'toggle') { S.open[url] = !S.open[url]; draw(); }
    else if (act === 'preview') {
      S.preview = S.preview === file ? null : file; draw();
      if (S.preview) { await getFile(file); draw(); }
    }
    else if (act === 'copy') copy(await getFile(file));
    else if (act === 'download') {
      const txt = await getFile(file);
      if (!txt) { toast('Nothing saved yet'); return; }
      download(file, txt); draw();
    }
  }

  function onChange(e) {
    if (e.target.id === 'lx-site') {
      S.siteId = e.target.value; store.set('llms-site', S.siteId);
      S.index = S.run = S.check = null; S.files = {}; S.open = {}; S.filter = 'all'; S.loaded = false; draw();
      loadSite().catch(err => { S.error = err.message; }).then(() => { S.loaded = true; draw(); });
    }
  }

  /* ---------- tabs ---------- */

  const SCHEMA_PARTS = ['hero', 'recent', 'fr', 'list', 'tools'];
  function showTab(name) {
    const llms = name === 'llms';
    document.querySelectorAll('.tabs [role="tab"]').forEach(b => {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1;
    });
    SCHEMA_PARTS.forEach(id => { const n = $(id); if (n) n.classList.toggle('tab-off', llms); });
    document.querySelector('.topbar').classList.toggle('tab-off', llms);
    $('llms').hidden = !llms;
    if (llms && !S.started) { S.started = true; load(); }
    draw();
  }

  function init() {
    const tabs = document.querySelector('.tabs');
    if (!tabs) return;
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
      const i = all.indexOf(document.activeElement);
      const n = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      n.focus(); n.click();
    });
    $('llms').addEventListener('click', onClick);
    $('llms').addEventListener('change', onChange);
    $('llms').addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === 'lx-token') { e.preventDefault(); $('llms').querySelector('[data-lx="save-token"]').click(); }
      if (e.key === 'Enter' && e.target.id === 'lx-add') { e.preventDefault(); $('llms').querySelector('[data-lx="add"]').click(); }
    });
    if (location.hash === '#llms') showTab('llms');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
